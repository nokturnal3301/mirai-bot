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

const failIfNull = <T, E = string>(
	error: E,
	value: T | null | undefined,
): Flow<T, E> => (value != null ? of(value) : fail(error));

export const F = {
	of,
	stop,
	fail,
	failIfNull,
};

export type Chain<T, E> = {
	pipe: <U, E2>(
		fn: (value: T) => MaybePromise<Flow<U, E2>>,
	) => Chain<U, E | E2>;
	recover: <U, E2>(
		fn: (error: E) => MaybePromise<Flow<U, E2>>,
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

	run: () => Promise.resolve(initial),

	result: () =>
		Promise.resolve(initial).then((flow) =>
			flow._tag === "Continue" ? flow.value : null,
		),
});
