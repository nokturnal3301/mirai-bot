import { describe, expect, test } from "bun:test";
import { createSemaphore, mapConcurrent } from "lib/concurrency";

describe("concurrency", () => {
	test("maps in input order with bounded concurrency", async () => {
		let active = 0;
		let peak = 0;
		const result = await mapConcurrent([1, 2, 3, 4, 5], 2, async (value) => {
			active++;
			peak = Math.max(peak, active);
			await Bun.sleep(2);
			active--;
			return value * 2;
		});

		expect(result).toEqual([2, 4, 6, 8, 10]);
		expect(peak).toBe(2);
	});

	test("releases a semaphore permit when a task throws", async () => {
		const semaphore = createSemaphore(1);
		const failed = semaphore.withPermit(async () => {
			throw new Error("failed");
		});
		const next = semaphore.withPermit(async () => "ok");

		await expect(failed).rejects.toThrow("failed");
		expect(await next).toBe("ok");
	});

	test("removes an aborted waiter without consuming a permit", async () => {
		const semaphore = createSemaphore(1);
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let releaseFirst: () => void = () => {};
		const first = semaphore.withPermit(
			() =>
				new Promise<void>((resolve) => {
					markStarted();
					releaseFirst = resolve;
				}),
		);
		await started;

		const controller = new AbortController();
		const aborted = semaphore.withPermit(
			async () => "never",
			controller.signal,
		);
		const third = semaphore.withPermit(async () => "third");
		controller.abort("too late");
		await expect(aborted).rejects.toThrow("too late");
		releaseFirst();

		expect(await third).toBe("third");
		await first;
	});
});
