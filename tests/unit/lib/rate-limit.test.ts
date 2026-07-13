import { describe, test, expect } from "bun:test";
import { createRateLimiter } from "lib/rate-limit";

describe("createRateLimiter", () => {
	test("allows requests under the limit", () => {
		const limiter = createRateLimiter({ windowMs: 1000, maxPerWindow: 3 });

		expect(limiter.check("user-a")).toBe(true);
		expect(limiter.check("user-a")).toBe(true);
		expect(limiter.check("user-a")).toBe(true);
	});

	test("rejects after the limit is reached", () => {
		const limiter = createRateLimiter({ windowMs: 1000, maxPerWindow: 2 });

		expect(limiter.check("user-b")).toBe(true);
		expect(limiter.check("user-b")).toBe(true);
		expect(limiter.check("user-b")).toBe(false);
	});

	test("isolates keys", () => {
		const limiter = createRateLimiter({ windowMs: 1000, maxPerWindow: 1 });

		expect(limiter.check("user-c")).toBe(true);
		expect(limiter.check("user-c")).toBe(false);
		expect(limiter.check("user-d")).toBe(true);
	});

	test("resets after the window expires", async () => {
		const limiter = createRateLimiter({ windowMs: 30, maxPerWindow: 1 });

		expect(limiter.check("user-e")).toBe(true);
		expect(limiter.check("user-e")).toBe(false);
		await new Promise((r) => setTimeout(r, 40));
		expect(limiter.check("user-e")).toBe(true);
	});

	test("bounds unique keys by evicting the least recently used bucket", () => {
		const limiter = createRateLimiter({
			windowMs: 10_000,
			maxPerWindow: 1,
			maxKeys: 2,
		});

		expect(limiter.check("oldest")).toBe(true);
		expect(limiter.check("newer")).toBe(true);
		expect(limiter.check("newest")).toBe(true);
		expect(limiter.check("oldest")).toBe(true);
	});
});
