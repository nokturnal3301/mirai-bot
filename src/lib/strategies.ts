import type { ExtractionError } from "./errors";
import { extractionError, extractionErrorFrom } from "./errors";
import type { Chain, Flow } from "./flow";
import { chain, F } from "./flow";
import type { CircuitBreakerPolicy } from "./circuit-breaker";
import {
	acquireCircuitPermit,
	clearCircuitBreakers,
	completeCircuitPermit,
} from "./circuit-breaker";
import {
	clearStrategyLatencies,
	recordStrategyLatency,
	resolveStrategyDelay,
	type StrategyDelay,
} from "./strategy-latency";
import { logger } from "./logger";

export { adaptiveDelay } from "./strategy-latency";
export type { AdaptiveDelay, StrategyDelay } from "./strategy-latency";

type MaybePromise<T> = T | Promise<T>;
type StrategyResult<T> = MaybePromise<Flow<T, ExtractionError>>;

export type StrategyFact<T> = Readonly<{
	id: symbol;
	name: string;
	_type?: T;
}>;

export type StrategyContext = Readonly<{
	signal: AbortSignal;
	resolve: <T>(
		fact: StrategyFact<T>,
		load: (signal: AbortSignal) => Promise<T>,
	) => Promise<T>;
}>;

export type StrategyKind = "direct" | "metadata" | "fallback";
export type StrategyCost = "cheap" | "normal" | "expensive";

type StrategyExecutor<Input, Output> = (
	input: Input,
	context: StrategyContext,
) => StrategyResult<Output>;

type StrategyPredicate<Input> = (
	input: Input,
	context: StrategyContext,
) => boolean;

export type StrategyOptions<Input> = Readonly<{
	kind: StrategyKind;
	cost: StrategyCost;
	after?: StrategyDelay;
	when?: StrategyPredicate<Input>;
	circuitBreaker?: CircuitBreakerPolicy;
	afterFailureOf?: readonly string[];
}>;

export type Strategy<Input, Output> = Readonly<{
	name: string;
	kind: StrategyKind;
	cost: StrategyCost;
	after: StrategyDelay;
	when?: StrategyPredicate<Input>;
	circuitBreaker?: CircuitBreakerPolicy;
	afterFailureOf?: readonly string[];
	execute: StrategyExecutor<Input, Output>;
}>;

export type StrategyDefinition<Input, Output> = Readonly<{
	name: string;
	with: (options: StrategyOptions<Input>) => Strategy<Input, Output>;
}>;

export type StrategyExecutionPlan<Input, Output> = Readonly<{
	mode: "sequence" | "hedge";
	strategies: readonly Strategy<Input, Output>[];
}>;

export type StrategyExecution<Input, Output> = Readonly<{
	tag: string;
	input: Input;
	plan: StrategyExecutionPlan<Input, Output>;
	signal?: AbortSignal;
}>;

export const clearStrategyRuntime = (): void => {
	clearStrategyLatencies();
	clearCircuitBreakers();
};

export const strategyFact = <T>(name: string): StrategyFact<T> => ({
	id: Symbol(name),
	name,
});

export const defineStrategy = <Input, Output>(
	name: string,
	executor: StrategyExecutor<Input, Output>,
): StrategyDefinition<Input, Output> =>
	Object.freeze({
		name,
		with: (options: StrategyOptions<Input>): Strategy<Input, Output> =>
			Object.freeze({
				name,
				kind: options.kind,
				cost: options.cost,
				after:
					typeof options.after === "number"
						? Math.max(0, options.after)
						: (options.after ?? 0),
				...(options.when ? { when: options.when } : {}),
				...(options.circuitBreaker
					? {
							circuitBreaker: Object.freeze({
								...options.circuitBreaker,
								...(options.circuitBreaker.failureCodes
									? {
											failureCodes: Object.freeze([
												...options.circuitBreaker.failureCodes,
											]),
										}
									: {}),
							}),
						}
					: {}),
				...(options.afterFailureOf
					? { afterFailureOf: Object.freeze([...options.afterFailureOf]) }
					: {}),
				execute: executor,
			}),
	});

const plan = <Input, Output>(
	mode: StrategyExecutionPlan<Input, Output>["mode"],
	strategies: readonly Strategy<Input, Output>[],
): StrategyExecutionPlan<Input, Output> =>
	Object.freeze({ mode, strategies: Object.freeze([...strategies]) });

export const sequence = <Input, Output>(
	strategies: readonly Strategy<Input, Output>[],
): StrategyExecutionPlan<Input, Output> => plan("sequence", strategies);

export const hedge = <Input, Output>(
	strategies: readonly Strategy<Input, Output>[],
): StrategyExecutionPlan<Input, Output> => plan("hedge", strategies);

const createStrategyContext = (signal: AbortSignal): StrategyContext => {
	const facts = new Map<symbol, Promise<unknown>>();

	return {
		signal,
		resolve: <T>(
			fact: StrategyFact<T>,
			load: (signal: AbortSignal) => Promise<T>,
		): Promise<T> => {
			const existing = facts.get(fact.id);
			if (existing) return existing as Promise<T>;

			const pending = Promise.resolve().then(() => load(signal));
			facts.set(fact.id, pending);
			return pending;
		},
	};
};

export const retry = async <T>(
	tag: string,
	attempts: number,
	run: () => Promise<Flow<T, ExtractionError>>,
): Promise<Flow<T, ExtractionError>> => {
	let last: Flow<T, ExtractionError> = F.fail(
		extractionError("UNKNOWN", "no attempts"),
	);

	for (let attempt = 1; attempt <= attempts; attempt++) {
		const result = await run();
		last =
			result._tag === "Fail"
				? F.fail(extractionErrorFrom(result.error))
				: result;
		if (last._tag !== "Fail") return last;
		if (last.error.terminal || !last.error.retryable) return last;
		if (attempt < attempts) {
			logger.info(
				`[${tag}] retry ${attempt}/${attempts}: ${last.error.message}`,
			);
		}
	}

	return last;
};

export type HedgedRetryOptions = Readonly<{
	attempts: number;
	after: number;
}>;

export const hedgedRetry = <T>(
	tag: string,
	options: HedgedRetryOptions,
	run: (signal: AbortSignal) => Promise<Flow<T, ExtractionError>>,
): Promise<Flow<T, ExtractionError>> => {
	const attempts = Math.max(1, Math.floor(options.attempts));
	const after = Math.max(0, options.after);

	return new Promise((resolve) => {
		const controllers = new Set<AbortController>();
		let started = 0;
		let active = 0;
		let settled = false;
		let lastFailure = extractionError("UNKNOWN", "no attempts");
		let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

		const finish = (result: Flow<T, ExtractionError>): void => {
			if (settled) return;
			settled = true;
			if (hedgeTimer) clearTimeout(hedgeTimer);
			for (const controller of controllers) {
				controller.abort(`${tag} hedged retry settled`);
			}
			resolve(result);
		};

		const start = (): void => {
			if (settled || started >= attempts) return;
			const attempt = ++started;
			const controller = new AbortController();
			controllers.add(controller);
			active++;
			if (attempt > 1) {
				logger.info(`[${tag}] hedging attempt ${attempt}/${attempts}`);
			}

			void Promise.resolve()
				.then(() => run(controller.signal))
				.catch((error) => F.fail(extractionErrorFrom(error)))
				.then((result) => {
					controllers.delete(controller);
					active--;
					if (settled) return;

					if (result._tag !== "Fail" || result.error.terminal) {
						finish(result);
						return;
					}

					lastFailure = result.error;
					if (started < attempts) {
						if (hedgeTimer) {
							clearTimeout(hedgeTimer);
							hedgeTimer = undefined;
						}
						start();
					} else if (active === 0) finish(F.fail(lastFailure));
				});
		};

		start();
		if (attempts > 1 && !settled) {
			hedgeTimer = setTimeout(() => {
				hedgeTimer = undefined;
				start();
			}, after);
		}
	});
};

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const runAttempt = async <Input, Output>(
	tag: string,
	input: Input,
	strategy: Strategy<Input, Output>,
	context: StrategyContext,
): Promise<Flow<Output, ExtractionError>> => {
	const startedAt = performance.now();
	const circuitPermit = strategy.circuitBreaker
		? acquireCircuitPermit(tag, strategy.name, strategy.circuitBreaker)
		: undefined;
	if (strategy.circuitBreaker && !circuitPermit) {
		logger.warn(`[${tag}] skipping ${strategy.name}: circuit open`);
		return F.fail(
			extractionError("UPSTREAM_REJECTED", `${strategy.name} circuit is open`),
		);
	}
	logger.info(
		`[${tag}] trying ${strategy.name} (${strategy.kind}, ${strategy.cost})...`,
	);

	const aborted = new Promise<Flow<Output, ExtractionError>>((resolve) => {
		const stop = () =>
			resolve(
				F.fail(
					extractionError(
						"ABORTED",
						errorMessage(context.signal.reason ?? "aborted"),
					),
				),
			);

		if (context.signal.aborted) stop();
		else context.signal.addEventListener("abort", stop, { once: true });
	});

	const executeStrategy = () =>
		Promise.resolve()
			.then(() => strategy.execute(input, context))
			.then(
				(result): Flow<Output, ExtractionError> =>
					result._tag === "Fail"
						? F.fail(extractionErrorFrom(result.error))
						: result,
			)
			.catch(
				(error): Flow<Output, ExtractionError> =>
					F.fail(extractionErrorFrom(error)),
			);
	const executed = context.signal.aborted ? aborted : executeStrategy();

	const result = await Promise.race([executed, aborted]);
	const durationMs = performance.now() - startedAt;
	if (circuitPermit) {
		const transition = completeCircuitPermit(circuitPermit, result);
		if (transition === "opened") {
			logger.warn(`[${tag}] ${strategy.name} circuit opened`);
		} else if (transition === "closed") {
			logger.info(`[${tag}] ${strategy.name} circuit recovered`);
		}
	}

	if (result._tag === "Continue") {
		recordStrategyLatency(tag, strategy.name, durationMs);
		logger.info(
			`[${tag}] got via ${strategy.name} in ${durationMs.toFixed(0)}ms`,
		);
	} else if (result._tag === "Stop") {
		logger.info(
			`[${tag}] ${strategy.name} stopped in ${durationMs.toFixed(0)}ms`,
		);
	} else if (result.error.code !== "ABORTED") {
		logger.warn(
			`[${tag}] ${strategy.name} failed (${result.error.code}) in ${durationMs.toFixed(0)}ms: ${result.error.message}`,
		);
	}

	return result;
};

const noStrategies = (): Flow<never, ExtractionError> =>
	F.fail(extractionError("UNKNOWN", "no strategies"));

const runSequence = async <Input, Output>(
	tag: string,
	input: Input,
	context: StrategyContext,
	strategies: readonly Strategy<Input, Output>[],
): Promise<Flow<Output, ExtractionError>> => {
	let lastFailure = extractionError("UNKNOWN", "no strategies");

	for (const strategy of strategies) {
		if (strategy.when && !strategy.when(input, context)) continue;

		const result = await runAttempt(tag, input, strategy, context);
		if (result._tag !== "Fail") return result;
		lastFailure = result.error;
		if (lastFailure.terminal || context.signal.aborted) {
			return F.fail(lastFailure);
		}
	}

	logger.warn(`[${tag}] all strategies failed: ${lastFailure.message}`);
	return F.fail(lastFailure);
};

const runHedge = <Input, Output>(
	tag: string,
	input: Input,
	context: StrategyContext,
	strategies: readonly Strategy<Input, Output>[],
	stopPlan: (reason?: unknown) => void,
): Promise<Flow<Output, ExtractionError>> => {
	const eligible = strategies.filter(
		(strategy) => !strategy.when || strategy.when(input, context),
	);
	if (eligible.length === 0) return Promise.resolve(noStrategies());

	return new Promise<Flow<Output, ExtractionError>>((resolve) => {
		const started = new Set<number>();
		const completed = new Set<number>();
		const timers: ReturnType<typeof setTimeout>[] = [];
		let settled = false;
		let lastFailure: ExtractionError | undefined;
		const failedNames = new Set<string>();

		const finish = (result: Flow<Output, ExtractionError>) => {
			if (settled) return;
			settled = true;
			for (const timer of timers) clearTimeout(timer);
			resolve(result);
			stopPlan("strategy plan settled");
		};

		const startNextPending = () => {
			const next = eligible.findIndex(
				(strategy, index) =>
					!started.has(index) &&
					(!strategy.afterFailureOf ||
						strategy.afterFailureOf.every((name) => failedNames.has(name))),
			);
			if (next >= 0) start(next);
		};

		const start = (index: number) => {
			if (settled || started.has(index)) return;
			const strategy = eligible[index];
			if (!strategy) return;
			started.add(index);

			void runAttempt(tag, input, strategy, context).then((result) => {
				if (settled) return;
				if (result._tag !== "Fail") {
					finish(result);
					return;
				}

				completed.add(index);
				lastFailure = result.error;
				failedNames.add(strategy.name);
				if (result.error.terminal) {
					finish(F.fail(result.error));
					return;
				}

				startNextPending();
				if (completed.size === eligible.length) {
					finish(
						F.fail(
							lastFailure ??
								extractionError("UNKNOWN", "all strategies failed"),
						),
					);
				}
			});
		};

		context.signal.addEventListener(
			"abort",
			() => {
				if (!settled) {
					finish(F.fail(extractionError("ABORTED", "strategy plan aborted")));
				}
			},
			{ once: true },
		);

		eligible.forEach((strategy, index) => {
			const delay = resolveStrategyDelay(tag, strategy.after);
			if (delay === 0) start(index);
			else timers.push(setTimeout(() => start(index), delay));
		});
	});
};

const runPlan = async <Input, Output>({
	tag,
	input,
	plan,
	signal: externalSignal,
}: StrategyExecution<Input, Output>): Promise<
	Flow<Output, ExtractionError>
> => {
	const controller = new AbortController();
	const abortFromExternal = () => controller.abort(externalSignal?.reason);

	if (externalSignal?.aborted) abortFromExternal();
	else
		externalSignal?.addEventListener("abort", abortFromExternal, {
			once: true,
		});

	const context = createStrategyContext(controller.signal);
	const stopPlan = (reason?: unknown) => {
		if (!controller.signal.aborted) controller.abort(reason);
	};

	try {
		if (plan.mode === "hedge") {
			return await runHedge(tag, input, context, plan.strategies, stopPlan);
		}
		return await runSequence(tag, input, context, plan.strategies);
	} finally {
		stopPlan("strategy plan completed");
		externalSignal?.removeEventListener("abort", abortFromExternal);
	}
};

export const execute = <Input, Output>(
	execution: StrategyExecution<Input, Output>,
): Chain<Output, ExtractionError> => chain(runPlan(execution));
