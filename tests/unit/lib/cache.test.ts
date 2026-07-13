import { describe, expect, test } from "bun:test";
import { normalizeUrl } from "lib";

describe("normalizeUrl", () => {
	test("drops query params (tracking)", () => {
		expect(normalizeUrl("https://instagram.com/p/ABC123/?igsh=xyz")).toBe(
			"instagram.com/p/ABC123",
		);
	});

	test("strips www / m host prefixes", () => {
		expect(normalizeUrl("https://www.tiktok.com/@u/video/1")).toBe(
			"tiktok.com/@u/video/1",
		);
		expect(normalizeUrl("https://m.youtube.com/shorts/abc")).toBe(
			"youtube.com/shorts/abc",
		);
	});

	test("folds instagram reel/reels/p/tv onto the same shortcode", () => {
		const key = "instagram.com/p/ABC123";
		expect(normalizeUrl("https://www.instagram.com/reel/ABC123/")).toBe(key);
		expect(normalizeUrl("https://instagram.com/reels/ABC123")).toBe(key);
		expect(normalizeUrl("https://instagram.com/tv/ABC123/")).toBe(key);
		expect(normalizeUrl("https://instagram.com/p/ABC123/")).toBe(key);
	});

	test("lowercases host, strips trailing slash", () => {
		expect(normalizeUrl("https://Reddit.com/r/aww/comments/xyz/")).toBe(
			"reddit.com/r/aww/comments/xyz",
		);
	});

	test("returns input unchanged when not a url", () => {
		expect(normalizeUrl("not a url")).toBe("not a url");
	});
});
