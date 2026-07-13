import { describe, expect, test } from "bun:test";
import { extractionError, type ExtractionError } from "lib/errors";
import { F, type Flow } from "lib/flow";
import {
	adaptiveDelay,
	clearStrategyRuntime,
	defineStrategy,
	execute,
	hedge,
	hedgedRetry,
	retry,
	sequence,
	strategyFact,
	type Strategy,
	type StrategyContext,
	type StrategyOptions,
} from "lib/strategies";

const fail = (message: string) => F.fail(extractionError("UNKNOWN", message));

const configured = <Input, Output>(
	name: string,
	run: (
		input: Input,
		context: StrategyContext,
	) => Promise<Flow<Output, ExtractionError>>,
	options: Partial<StrategyOptions<Input>> = {},
): Strategy<Input, Output> =>
	defineStrategy(name, run).with({
		kind: options.kind ?? "metadata",
		cost: options.cost ?? "normal",
		...(options.after === undefined ? {} : { after: options.after }),
		...(options.when ? { when: options.when } : {}),
		...(options.circuitBreaker
			? { circuitBreaker: options.circuitBreaker }
			: {}),
		...(options.afterFailureOf
			? { afterFailureOf: options.afterFailureOf }
			: {}),
	});

const runSequence = <Input, Output>(
	input: Input,
	strategies: readonly Strategy<Input, Output>[],
) => execute({ tag: "test", input, plan: sequence(strategies) }).run();

describe("declarative strategy plans", () => {
	test("returns the first successful sequence result", async () => {
		const result = await runSequence(undefined, [
			configured("first", async () => F.of("success")),
			configured("second", async () => F.of("should not reach")),
		]);

		expect(result).toEqual({ _tag: "Continue", value: "success" });
	});

	test("falls back after a failure or thrown error", async () => {
		const order: string[] = [];
		const result = await runSequence(undefined, [
			configured("first", async () => {
				order.push("first");
				return fail("bad");
			}),
			configured("second", async (): Promise<Flow<string, ExtractionError>> => {
				order.push("second");
				throw new Error("boom");
			}),
			configured("third", async () => {
				order.push("third");
				return F.of("fallback");
			}),
		]);

		expect(result).toEqual({ _tag: "Continue", value: "fallback" });
		expect(order).toEqual(["first", "second", "third"]);
	});

	test("returns the last failure when every strategy fails", async () => {
		const result = await runSequence(undefined, [
			configured("first", async () => fail("first err")),
			configured("second", async (): Promise<Flow<string, ExtractionError>> => {
				throw new Error("second err");
			}),
		]);

		expect(result._tag).toBe("Fail");
		if (result._tag === "Fail") {
			expect(result.error.message).toBe("second err");
		}
	});

	test("returns a typed failure for an empty plan", async () => {
		const result = await runSequence<undefined, string>(undefined, []);

		expect(result).toEqual({
			_tag: "Fail",
			error: extractionError("UNKNOWN", "no strategies"),
		});
	});

	test("does not run fallbacks after a terminal error", async () => {
		let fallbackCalls = 0;
		const result = await runSequence(undefined, [
			configured("first", async () =>
				F.fail(extractionError("MEDIA_TOO_LARGE", "FILE_TOO_LARGE")),
			),
			configured("fallback", async () => {
				fallbackCalls++;
				return F.of("unexpected");
			}),
		]);

		expect(result).toEqual({
			_tag: "Fail",
			error: extractionError("MEDIA_TOO_LARGE", "FILE_TOO_LARGE"),
		});
		expect(fallbackCalls).toBe(0);
	});

	test("skips strategies whose predicate does not match", async () => {
		let skippedCalls = 0;
		const result = await runSequence("run", [
			configured(
				"skipped",
				async () => {
					skippedCalls++;
					return F.of("unexpected");
				},
				{ when: (input) => input === "skip" },
			),
			configured("winner", async (input) => F.of(input)),
		]);

		expect(result).toEqual({ _tag: "Continue", value: "run" });
		expect(skippedCalls).toBe(0);
	});

	test("keeps definitions and plans immutable", () => {
		const definition = defineStrategy("one", async (input: string) =>
			F.of(input),
		);
		const strategy = definition.with({ kind: "direct", cost: "cheap" });
		const executionPlan = sequence([strategy]);

		expect(Object.isFrozen(definition)).toBe(true);
		expect(Object.isFrozen(strategy)).toBe(true);
		expect(Object.isFrozen(executionPlan)).toBe(true);
		expect(Object.isFrozen(executionPlan.strategies)).toBe(true);
	});

	test("pipes only a successful result into materialization", async () => {
		let calls = 0;
		const success = await execute({
			tag: "test",
			input: 4,
			plan: sequence([
				configured<number, number>("one", async (input) => F.of(input)),
			]),
		})
			.pipe(async (value) => {
				calls++;
				return F.of(value * 2);
			})
			.run();

		const failure = await execute({
			tag: "test",
			input: 4,
			plan: sequence([
				configured<number, number>("one", async () => fail("bad")),
			]),
		})
			.pipe(async (value) => {
				calls++;
				return F.of(value * 2);
			})
			.run();

		expect(success).toEqual({ _tag: "Continue", value: 8 });
		expect(failure._tag).toBe("Fail");
		expect(calls).toBe(1);
	});
});

describe("retry", () => {
	test("returns the first non-Fail without re-running", async () => {
		let calls = 0;
		const result = await retry("test", 3, async () => {
			calls++;
			return F.of("ok");
		});

		expect(result._tag).toBe("Continue");
		expect(calls).toBe(1);
	});

	test("re-runs retryable failures until success", async () => {
		let calls = 0;
		const result = await retry("test", 3, async () => {
			calls++;
			return calls < 3
				? F.fail(extractionError("UPSTREAM_REJECTED", "nope"))
				: F.of("won");
		});

		expect(result).toEqual({ _tag: "Continue", value: "won" });
		expect(calls).toBe(3);
	});

	test("short-circuits Stop and terminal failures", async () => {
		let stopCalls = 0;
		const stopped = await retry<string>("test", 3, async () => {
			stopCalls++;
			return F.stop();
		});

		let failureCalls = 0;
		const failed = await retry<string>("test", 3, async () => {
			failureCalls++;
			return F.fail(extractionError("MEDIA_TOO_LARGE", "FILE_TOO_LARGE"));
		});

		expect(stopped._tag).toBe("Stop");
		expect(stopCalls).toBe(1);
		expect(failed).toEqual({
			_tag: "Fail",
			error: extractionError("MEDIA_TOO_LARGE", "FILE_TOO_LARGE"),
		});
		expect(failureCalls).toBe(1);
	});
});

describe("hedged retry", () => {
	test("starts a delayed attempt and aborts the slower route", async () => {
		let calls = 0;
		let slowAborted = false;
		const result = await hedgedRetry(
			"test",
			{ attempts: 3, after: 2 },
			async (signal) => {
				calls++;
				if (calls > 1) return F.of("fast");

				return new Promise((resolve) => {
					signal.addEventListener(
						"abort",
						() => {
							slowAborted = true;
							resolve(F.fail(extractionError("ABORTED", "lost hedge")));
						},
						{ once: true },
					);
				});
			},
		);

		expect(result).toEqual({ _tag: "Continue", value: "fast" });
		expect(calls).toBe(2);
		expect(slowAborted).toBe(true);
	});

	test("starts the next route immediately after a definite failure", async () => {
		let calls = 0;
		const result = await hedgedRetry(
			"test",
			{ attempts: 3, after: 10_000 },
			async () => {
				calls++;
				return calls === 1
					? F.fail(extractionError("UPSTREAM_REJECTED", "dead route"))
					: F.of("recovered");
			},
		);

		expect(result).toEqual({ _tag: "Continue", value: "recovered" });
		expect(calls).toBe(2);
	});
});

describe("hedged strategy plans", () => {
	test("starts a delayed fallback immediately after a definite failure", async () => {
		const order: string[] = [];
		const result = await execute({
			tag: "test",
			input: "https://example.com",
			plan: hedge([
				configured("fast-path", async () => {
					order.push("fast-path");
					return fail("not available");
				}),
				configured(
					"fallback",
					async () => {
						order.push("fallback");
						return F.of("ok");
					},
					{ after: 10_000 },
				),
			]),
		}).run();

		expect(result).toEqual({ _tag: "Continue", value: "ok" });
		expect(order).toEqual(["fast-path", "fallback"]);
	});

	test("waits for declared sibling failures before accelerating a fallback", async () => {
		const events: string[] = [];
		const result = await execute({
			tag: "test",
			input: undefined,
			plan: hedge([
				configured("first", async () => {
					events.push("first");
					return fail("first failed");
				}),
				configured("second", async () => {
					await Bun.sleep(10);
					events.push("second");
					return fail("second failed");
				}),
				configured(
					"fallback",
					async () => {
						events.push("fallback");
						return F.of("ok");
					},
					{
						after: 10_000,
						afterFailureOf: ["first", "second"],
					},
				),
			]),
		}).run();

		expect(result).toEqual({ _tag: "Continue", value: "ok" });
		expect(events).toEqual(["first", "second", "fallback"]);
	});

	test("starts a hedge after its configured delay", async () => {
		const startedAt = performance.now();
		const result = await execute({
			tag: "test",
			input: undefined,
			plan: hedge([
				configured(
					"slow",
					async (_input, context) =>
						new Promise((resolve) => {
							context.signal.addEventListener(
								"abort",
								() => resolve(F.fail(extractionError("ABORTED", "aborted"))),
								{ once: true },
							);
						}),
				),
				configured("hedge", async () => F.of("hedged"), { after: 10 }),
			]),
		}).run();

		expect(result).toEqual({ _tag: "Continue", value: "hedged" });
		expect(performance.now() - startedAt).toBeLessThan(500);
	});

	test("aborts losing strategies after a winner settles", async () => {
		let losingStrategyAborted = false;
		const result = await execute({
			tag: "test",
			input: undefined,
			plan: hedge([
				configured(
					"loser",
					async (_input, context) =>
						new Promise((resolve) => {
							context.signal.addEventListener(
								"abort",
								() => {
									losingStrategyAborted = true;
									resolve(F.fail(extractionError("ABORTED", "aborted")));
								},
								{ once: true },
							);
						}),
				),
				configured("winner", async () => F.of("winner"), { after: 5 }),
			]),
		}).run();

		expect(result).toEqual({ _tag: "Continue", value: "winner" });
		expect(losingStrategyAborted).toBe(true);
	});

	test("memoizes shared facts across concurrent strategies", async () => {
		let loads = 0;
		const shared = strategyFact<number>("shared");
		const loadShared = (context: StrategyContext) =>
			context.resolve(shared, async () => {
				loads++;
				await Promise.resolve();
				return 42;
			});

		const result = await execute({
			tag: "test",
			input: undefined,
			plan: hedge([
				configured("first", async (_input, context) => {
					await loadShared(context);
					return fail("nope");
				}),
				configured("second", async (_input, context) =>
					F.of(`value:${await loadShared(context)}`),
				),
			]),
		}).run();

		expect(result).toEqual({ _tag: "Continue", value: "value:42" });
		expect(loads).toBe(1);
	});

	test("does not launch a delayed fallback after a terminal failure", async () => {
		let fallbackCalls = 0;
		const result = await execute({
			tag: "test",
			input: undefined,
			plan: hedge([
				configured("terminal", async () =>
					F.fail(extractionError("MEDIA_TOO_LARGE", "FILE_TOO_LARGE")),
				),
				configured(
					"fallback",
					async () => {
						fallbackCalls++;
						return F.of("unexpected");
					},
					{ after: 10_000 },
				),
			]),
		}).run();

		expect(result).toEqual({
			_tag: "Fail",
			error: extractionError("MEDIA_TOO_LARGE", "FILE_TOO_LARGE"),
		});
		expect(fallbackCalls).toBe(0);
	});

	test("does not execute when the external signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort("request cancelled");
		let calls = 0;

		const result = await execute({
			tag: "test",
			input: undefined,
			plan: sequence([
				configured("never", async () => {
					calls++;
					return F.of("unexpected");
				}),
			]),
			signal: controller.signal,
		}).run();

		expect(result).toEqual({
			_tag: "Fail",
			error: extractionError("ABORTED", "request cancelled"),
		});
		expect(calls).toBe(0);
	});

	test("retains declared kind and cost as immutable plan metadata", () => {
		const strategy = configured("web", async () => F.of("ok"), {
			kind: "direct",
			cost: "cheap",
		});
		expect(strategy).toMatchObject({ kind: "direct", cost: "cheap" });
		expect(Object.isFrozen(strategy)).toBe(true);
	});

	test("does not turn descriptive cost metadata into global admission control", async () => {
		let active = 0;
		let peak = 0;
		const strategy = (name: string) =>
			configured(
				name,
				async () => {
					active++;
					peak = Math.max(peak, active);
					await Bun.sleep(5);
					active--;
					return F.of(name);
				},
				{ cost: "expensive" },
			);

		await Promise.all(
			["one", "two", "three"].map((name) =>
				execute({
					tag: "cost-metadata",
					input: undefined,
					plan: sequence([strategy(name)]),
				}).run(),
			),
		);
		expect(peak).toBe(3);
	});

	test("uses observed latency for an adaptive hedge delay", async () => {
		clearStrategyRuntime();
		await execute({
			tag: "adaptive-test",
			input: undefined,
			plan: sequence([
				configured("primary", async () => {
					await Bun.sleep(20);
					return F.of("warm");
				}),
			]),
		}).run();

		const startedAt = performance.now();
		let hedgeStartedAt = 0;
		const result = await execute({
			tag: "adaptive-test",
			input: undefined,
			plan: hedge([
				configured(
					"primary",
					async (_input, context) =>
						new Promise((resolve) => {
							context.signal.addEventListener(
								"abort",
								() => resolve(fail("aborted")),
								{ once: true },
							);
						}),
				),
				configured(
					"hedge",
					async () => {
						hedgeStartedAt = performance.now();
						return F.of("hedged");
					},
					{
						after: adaptiveDelay("primary", {
							min: 1,
							max: 100,
							fallback: 90,
						}),
					},
				),
			]),
		}).run();

		const delay = hedgeStartedAt - startedAt;
		expect(result).toEqual({ _tag: "Continue", value: "hedged" });
		expect(delay).toBeGreaterThanOrEqual(10);
		expect(delay).toBeLessThan(70);
	});

	test("opens an explicit circuit breaker after consecutive failures", async () => {
		clearStrategyRuntime();
		let guardedCalls = 0;
		const guarded = configured(
			"guarded",
			async () => {
				guardedCalls++;
				return F.fail(extractionError("UPSTREAM_REJECTED", "HTTP 503"));
			},
			{ circuitBreaker: { failures: 2, resetAfter: 10_000 } },
		);
		const fallback = configured("fallback", async () => F.of("ok"));

		for (let attempt = 0; attempt < 3; attempt++) {
			const result = await runSequence(undefined, [guarded, fallback]);
			expect(result).toEqual({ _tag: "Continue", value: "ok" });
		}

		expect(guardedCalls).toBe(2);
	});

	test("allows only one half-open probe after the reset delay", async () => {
		clearStrategyRuntime();
		let calls = 0;
		let releaseProbe: () => void = () => {};
		let markProbeStarted: () => void = () => {};
		const probeStarted = new Promise<void>((resolve) => {
			markProbeStarted = resolve;
		});
		const probeBlocked = new Promise<void>((resolve) => {
			releaseProbe = resolve;
		});
		const guarded = configured(
			"half-open",
			async () => {
				calls++;
				if (calls === 1) {
					return F.fail(extractionError("UPSTREAM_REJECTED", "blocked"));
				}
				if (calls === 2) {
					markProbeStarted();
					await probeBlocked;
				}
				return F.of("healthy");
			},
			{ circuitBreaker: { failures: 1, resetAfter: 1 } },
		);
		const fallback = configured("half-open-fallback", async () =>
			F.of("fallback"),
		);

		expect(await runSequence(undefined, [guarded, fallback])).toEqual({
			_tag: "Continue",
			value: "fallback",
		});
		await Bun.sleep(2);
		const probe = runSequence(undefined, [guarded, fallback]);
		await probeStarted;
		expect(await runSequence(undefined, [guarded, fallback])).toEqual({
			_tag: "Continue",
			value: "fallback",
		});
		expect(calls).toBe(2);

		releaseProbe();
		expect(await probe).toEqual({ _tag: "Continue", value: "healthy" });
		expect(await runSequence(undefined, [guarded, fallback])).toEqual({
			_tag: "Continue",
			value: "healthy",
		});
		expect(calls).toBe(3);
	});

	test("resets the failure streak after a non-health failure", async () => {
		clearStrategyRuntime();
		const outcomes = [
			extractionError("UPSTREAM_REJECTED", "blocked"),
			extractionError("NO_MEDIA", "valid response without media"),
			extractionError("UPSTREAM_REJECTED", "blocked again"),
		];
		let calls = 0;
		const guarded = configured(
			"health-streak",
			async () => {
				const error = outcomes[calls++];
				return error ? F.fail(error) : F.of("healthy");
			},
			{ circuitBreaker: { failures: 2, resetAfter: 10_000 } },
		);
		const fallback = configured("health-streak-fallback", async () =>
			F.of("fallback"),
		);

		for (let attempt = 0; attempt < 3; attempt++) {
			expect(await runSequence(undefined, [guarded, fallback])).toEqual({
				_tag: "Continue",
				value: "fallback",
			});
		}
		expect(calls).toBe(3);
		expect(await runSequence(undefined, [guarded, fallback])).toEqual({
			_tag: "Continue",
			value: "healthy",
		});
	});
});
