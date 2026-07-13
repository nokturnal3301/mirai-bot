import { describe, test, expect } from "bun:test";
import { config } from "config";

describe("config", () => {
	test("telegram config has valid maxFileSize", () => {
		expect(config.telegram.maxFileSize).toBeGreaterThan(0);
		expect(config.telegram.maxFileSize).toBe(50 * 1024 * 1024);
	});

	test("youtube config has valid maxQuality", () => {
		expect(config.youtube.maxQuality).toBeGreaterThan(0);
		expect(config.youtube.maxQuality).toBeLessThanOrEqual(2160);
	});

	test("http config has valid defaults", () => {
		expect(config.http.timeout).toBeGreaterThan(0);
		expect(config.http.attempts).toBeGreaterThanOrEqual(1);
	});

	test("ffmpeg config has valid timeout", () => {
		expect(config.ffmpeg.timeout).toBeGreaterThan(0);
	});

	test("rateLimit config has valid window and cap", () => {
		expect(config.rateLimit.windowMs).toBeGreaterThan(0);
		expect(config.rateLimit.maxPerWindow).toBeGreaterThan(0);
	});
});
