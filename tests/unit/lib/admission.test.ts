import { describe, expect, test } from "bun:test";
import { config } from "config";
import {
	takeDownloadSlot,
	withCpuAdmission,
	withDownloadSlot,
} from "lib/admission";

describe("CPU admission", () => {
	test("serializes CPU-bound work without limiting unrelated strategies", async () => {
		let active = 0;
		let peak = 0;

		await Promise.all(
			[1, 2, 3].map(() =>
				withCpuAdmission(async () => {
					active++;
					peak = Math.max(peak, active);
					await Bun.sleep(5);
					active--;
				}),
			),
		);

		expect(peak).toBe(1);
	});
});

describe("download slots", () => {
	test("lets only a few requests hold fresh media at once", async () => {
		const limit = config.downloads.maxConcurrent;
		let active = 0;
		let peak = 0;

		await Promise.all(
			Array.from({ length: limit + 3 }, () =>
				withDownloadSlot(async () => {
					await takeDownloadSlot();
					active++;
					peak = Math.max(peak, active);
					await Bun.sleep(5);
					active--;
				}),
			),
		);

		expect(peak).toBe(limit);
	});

	test("frees the slot when the request fails", async () => {
		const limit = config.downloads.maxConcurrent;
		const failed = await Promise.allSettled(
			Array.from({ length: limit }, () =>
				withDownloadSlot(async () => {
					await takeDownloadSlot();
					throw new Error("failed");
				}),
			),
		);

		expect(failed.every(({ status }) => status === "rejected")).toBe(true);
		expect(
			await withDownloadSlot(async () => {
				await takeDownloadSlot();
				return "ok";
			}),
		).toBe("ok");
	});

	test("never queues requests that do not download, such as cached replies", async () => {
		const limit = config.downloads.maxConcurrent;
		let releaseHolders = () => {};
		const holdersDone = new Promise<void>((resolve) => {
			releaseHolders = resolve;
		});
		let holding = 0;
		const holders = Array.from({ length: limit }, () =>
			withDownloadSlot(async () => {
				await takeDownloadSlot();
				holding++;
				await holdersDone;
			}),
		);
		while (holding < limit) await Bun.sleep(1);

		expect(await withDownloadSlot(async () => "cached")).toBe("cached");
		expect(await takeDownloadSlot()).toBe(0);

		releaseHolders();
		await Promise.all(holders);
	});

	test("takes a single slot however often the request asks", async () => {
		const limit = config.downloads.maxConcurrent;
		const results = await Promise.all(
			Array.from({ length: limit }, () =>
				withDownloadSlot(async () => {
					await takeDownloadSlot();
					await takeDownloadSlot();
					return "ok";
				}),
			),
		);

		expect(results).toEqual(Array.from({ length: limit }, () => "ok"));
	});
});
