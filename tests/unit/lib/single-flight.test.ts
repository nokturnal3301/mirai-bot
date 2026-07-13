import { describe, expect, test } from "bun:test";
import { createSingleFlight } from "lib/single-flight";

describe("createSingleFlight", () => {
	test("shares one pending operation for the same key", async () => {
		const singleFlight = createSingleFlight<number>();
		let calls = 0;
		const run = async () => {
			calls++;
			await Bun.sleep(10);
			return 42;
		};

		const [first, second] = await Promise.all([
			singleFlight("same", run),
			singleFlight("same", run),
		]);

		expect([first, second]).toEqual([42, 42]);
		expect(calls).toBe(1);
	});

	test("clears a key after the operation settles", async () => {
		const singleFlight = createSingleFlight<number>();
		let calls = 0;
		const run = async () => ++calls;

		expect(await singleFlight("key", run)).toBe(1);
		expect(await singleFlight("key", run)).toBe(2);
	});

	test("does not combine different keys", async () => {
		const singleFlight = createSingleFlight<string>();
		const results = await Promise.all([
			singleFlight("a", async () => "a"),
			singleFlight("b", async () => "b"),
		]);

		expect(results).toEqual(["a", "b"]);
	});
});
