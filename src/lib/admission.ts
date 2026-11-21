import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "config";
import { createSemaphore } from "./concurrency";

const cpu = createSemaphore(1);

export const withCpuAdmission = <T>(
	run: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> => cpu.withPermit(run, signal);

const downloads = createSemaphore(config.downloads.maxConcurrent);
const slots = new AsyncLocalStorage<{ release?: () => void }>();

// A request that downloads fresh media keeps the file in memory until Telegram
// has it, so only a few hold a slot at once. The slot is taken on demand and
// handed back when the request ends, however it ends.
export const withDownloadSlot = async <T>(
	run: () => Promise<T>,
): Promise<T> => {
	const slot: { release?: () => void } = {};
	try {
		return await slots.run(slot, run);
	} finally {
		slot.release?.();
	}
};

// Resolves with the time spent queueing. Outside a request, or when the
// request already holds its slot, there is nothing to wait for.
export const takeDownloadSlot = async (): Promise<number> => {
	const slot = slots.getStore();
	if (!slot || slot.release) return 0;

	const startedAt = performance.now();
	const release = await downloads.acquire();
	if (slot.release) release();
	else slot.release = release;
	return performance.now() - startedAt;
};
