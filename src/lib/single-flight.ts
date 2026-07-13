export type SingleFlight<T> = (
	key: string,
	run: () => Promise<T>,
) => Promise<T>;

export const createSingleFlight = <T>(): SingleFlight<T> => {
	const pending = new Map<string, Promise<T>>();

	return (key, run) => {
		const existing = pending.get(key);
		if (existing) return existing;

		const task = Promise.resolve()
			.then(run)
			.finally(() => {
				if (pending.get(key) === task) pending.delete(key);
			});

		pending.set(key, task);
		return task;
	};
};
