type MaybePromise<T> = T | Promise<T>;

export type Flow<T, E = string> =
	| { _tag: "Continue"; value: T }
	| { _tag: "Stop" }
	| { _tag: "Fail"; error: E };

const of = <T, E = never>(value: T): Flow<T, E> => ({
	_tag: "Continue",
	value,
});
const stop = (): Flow<never, never> => ({ _tag: "Stop" });
const fail = <E = string>(error: E): Flow<never, E> => ({
	_tag: "Fail",
	error,
});

const map = <T, U, E>(flow: Flow<T, E>, fn: (value: T) => U): Flow<U, E> =>
	flow._tag === "Continue" ? of(fn(flow.value)) : flow;

const flatMap = <T, U, E>(
	flow: Flow<T, E>,
	fn: (value: T) => Flow<U, E>,
): Flow<U, E> => (flow._tag === "Continue" ? fn(flow.value) : flow);

const isFail = <T, E>(flow: Flow<T, E>): flow is { _tag: "Fail"; error: E } =>
	flow._tag === "Fail";

const isStop = <T, E>(flow: Flow<T, E>): flow is { _tag: "Stop" } =>
	flow._tag === "Stop";

const isContinue = <T, E>(
	flow: Flow<T, E>,
): flow is { _tag: "Continue"; value: T } => flow._tag === "Continue";

const fromNullable = <T>(value: T | null | undefined): Flow<T, never> =>
	value != null ? of(value) : stop();

const failIfNull = <T, E = string>(
	error: E,
	value: T | null | undefined,
): Flow<T, E> => (value != null ? of(value) : fail(error));

export const F = {
	of,
	stop,
	fail,
	map,
	flatMap,
	isFail,
	isStop,
	isContinue,
	fromNullable,
	failIfNull,
};

export type Chain<T, E> = {
	pipe: <U, E2>(
		fn: (value: T) => MaybePromise<Flow<U, E2>>,
	) => Chain<U, E | E2>;
	recover: <U, E2>(
		fn: (error: E) => MaybePromise<Flow<U, E2>>,
	) => Chain<T | U, E2>;
	onStop: <U, E2>(fn: () => MaybePromise<Flow<U, E2>>) => Chain<T | U, E | E2>;
	catch: <U, E2>(
		fn: (
			reason: { tag: "Stop" } | { tag: "Fail"; error: E },
		) => MaybePromise<Flow<U, E2>>,
	) => Chain<T | U, E2>;
	run: () => Promise<Flow<T, E>>;
	result: () => Promise<T | null>;
};

export const chain = <T, E = never>(
	initial: MaybePromise<Flow<T, E>>,
): Chain<T, E> => ({
	pipe: <U, E2>(
		fn: (value: T) => MaybePromise<Flow<U, E2>>,
	): Chain<U, E | E2> =>
		chain<U, E | E2>(
			Promise.resolve(initial).then((flow) =>
				flow._tag === "Continue" ? fn(flow.value) : (flow as Flow<U, E | E2>),
			),
		),

	recover: <U, E2>(
		fn: (error: E) => MaybePromise<Flow<U, E2>>,
	): Chain<T | U, E2> =>
		chain<T | U, E2>(
			Promise.resolve(initial).then((flow) =>
				flow._tag === "Fail" ? fn(flow.error) : flow,
			),
		),

	onStop: <U, E2>(fn: () => MaybePromise<Flow<U, E2>>): Chain<T | U, E | E2> =>
		chain<T | U, E | E2>(
			Promise.resolve(initial).then((flow) =>
				flow._tag === "Stop" ? fn() : flow,
			),
		),

	catch: <U, E2>(
		fn: (
			reason: { tag: "Stop" } | { tag: "Fail"; error: E },
		) => MaybePromise<Flow<U, E2>>,
	): Chain<T | U, E2> =>
		chain<T | U, E2>(
			Promise.resolve(initial).then((flow) => {
				if (flow._tag === "Fail") return fn({ tag: "Fail", error: flow.error });
				if (flow._tag === "Stop") return fn({ tag: "Stop" });
				return flow;
			}),
		),

	run: () => Promise.resolve(initial),

	result: () =>
		Promise.resolve(initial).then((flow) =>
			flow._tag === "Continue" ? flow.value : null,
		),
});
