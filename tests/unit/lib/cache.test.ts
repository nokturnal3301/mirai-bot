import { describe, expect, test } from "bun:test";
import type { Caption } from "extractors/types";
import { normalizeUrl, parseCachedMedia } from "lib";

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

describe("parseCachedMedia", () => {
	test("keeps the whole caption, so a repeat send shows the same card", () => {
		const caption: Caption = {
			source: "reddit",
			author: "someone",
			name: "Some One",
			verified: true,
			text: "hello",
			title: "Post title",
			flair: "News",
			community: "pics",
			stats: { views: 1000, likes: 10, comments: 3, score: 7 },
			postedAt: 1790000000,
			music: "Song — Artist",
			replyTo: "other",
			quote: { author: "quoted", text: "quoted text" },
			sensitive: true,
		};
		const cached = parseCachedMedia(
			JSON.stringify({ fileId: "file", type: "video", caption }),
		);

		expect(cached?.caption).toEqual(caption);
	});

	test("drops a malformed caption but keeps the cached file", () => {
		const cached = parseCachedMedia(
			JSON.stringify({ fileId: "file", caption: { stats: { views: null } } }),
		);

		expect(cached).toEqual({ fileId: "file" });
	});

	test("rejects entries without a file id or with broken JSON", () => {
		expect(parseCachedMedia(JSON.stringify({ type: "video" }))).toBeNull();
		expect(parseCachedMedia("{not json")).toBeNull();
	});
});
