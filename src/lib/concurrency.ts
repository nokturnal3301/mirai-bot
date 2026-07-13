export const mapConcurrent = async <T, R>(
	items: readonly T[],
	concurrency: number,
	map: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
	const limit = Math.max(1, Math.floor(concurrency));
	const results = new Array<R>(items.length);
	let nextIndex = 0;

	const worker = async (): Promise<void> => {
		while (nextIndex < items.length) {
			const index = nextIndex++;
			results[index] = await map(items[index] as T, index);
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => worker()),
	);
	return results;
};

export type Semaphore = {
	withPermit: <T>(run: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
};

export const createSemaphore = (concurrency: number): Semaphore => {
	const limit = Math.max(1, Math.floor(concurrency));
	type Waiter = {
		resolve: () => void;
		reject: (error: Error) => void;
		signal?: AbortSignal;
		onAbort?: () => void;
	};
	const waiting: Waiter[] = [];
	let active = 0;

	const abortError = (signal: AbortSignal): Error =>
		signal.reason instanceof Error
			? signal.reason
			: new Error(String(signal.reason ?? "semaphore wait aborted"));

	const acquire = async (signal?: AbortSignal): Promise<void> => {
		if (signal?.aborted) throw abortError(signal);
		if (active < limit) {
			active++;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject, signal };
			const onAbort = () => {
				const index = waiting.indexOf(waiter);
				if (index >= 0) waiting.splice(index, 1);
				reject(abortError(signal as AbortSignal));
			};
			waiter.onAbort = onAbort;
			waiting.push(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	};

	const release = (): void => {
		const next = waiting.shift();
		if (!next) {
			active--;
			return;
		}
		if (next.onAbort) {
			next.signal?.removeEventListener("abort", next.onAbort);
		}
		next.resolve();
	};

	return {
		withPermit: async <T>(
			run: () => Promise<T>,
			signal?: AbortSignal,
		): Promise<T> => {
			await acquire(signal);
			try {
				return await run();
			} finally {
				release();
			}
		},
	};
};
