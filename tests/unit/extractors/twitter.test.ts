import { describe, test, expect } from "bun:test";
import { twitter } from "extractors/twitter/extractor";
import { extractTweetId, tweetToken } from "extractors/twitter/utils";
import { SyndicationResponseSchema } from "extractors/twitter/schemas";

describe("twitter", () => {
	describe("match", () => {
		test("matches twitter.com URLs", () => {
			expect(twitter.match("https://twitter.com/user/status/123456")).toBe(
				true,
			);
		});

		test("matches x.com URLs", () => {
			expect(twitter.match("https://x.com/user/status/123")).toBe(true);
		});

		test("does not match non-status URLs", () => {
			expect(twitter.match("https://twitter.com/user")).toBe(false);
			expect(twitter.match("https://x.com/explore")).toBe(false);
		});

		test("does not match other domains", () => {
			expect(twitter.match("https://reddit.com/r/x/status/1")).toBe(false);
		});
	});

	describe("extractTweetId", () => {
		test("extracts from twitter.com URL", () => {
			expect(extractTweetId("https://twitter.com/user/status/1234567890")).toBe(
				"1234567890",
			);
		});

		test("extracts from x.com URL", () => {
			expect(extractTweetId("https://x.com/user/status/9876")).toBe("9876");
		});

		test("ignores trailing path/query", () => {
			expect(extractTweetId("https://x.com/user/status/42/photo/1?s=21")).toBe(
				"42",
			);
		});

		test("returns null for missing id", () => {
			expect(extractTweetId("https://x.com/user")).toBeNull();
		});
	});

	describe("tweetToken", () => {
		test("returns a non-empty string", () => {
			const token = tweetToken("1234567890123456789");
			expect(typeof token).toBe("string");
			expect(token.length).toBeGreaterThan(0);
		});

		test("does not contain zeros or dots", () => {
			const token = tweetToken("1234567890123456789");
			expect(token.includes("0")).toBe(false);
			expect(token.includes(".")).toBe(false);
		});

		test("is deterministic for the same id", () => {
			const id = "1234567890";
			expect(tweetToken(id)).toBe(tweetToken(id));
		});

		test("differs across distinct ids", () => {
			expect(tweetToken("1111111111")).not.toBe(tweetToken("2222222222"));
		});
	});

	describe("SyndicationResponseSchema", () => {
		test("parses tweet with single photo", () => {
			const parsed = SyndicationResponseSchema.parse({
				id_str: "1",
				mediaDetails: [
					{
						type: "photo",
						media_url_https: "https://pbs/foo.jpg",
						original_info: { width: 1200, height: 800 },
					},
				],
			});
			expect(parsed.mediaDetails?.[0]?.type).toBe("photo");
			expect(parsed.mediaDetails?.[0]?.media_url_https).toBe(
				"https://pbs/foo.jpg",
			);
		});

		test("parses tweet with video variants", () => {
			const parsed = SyndicationResponseSchema.parse({
				id_str: "1",
				mediaDetails: [
					{
						type: "video",
						original_info: { width: 1280, height: 720 },
						video_info: {
							duration_millis: 30000,
							variants: [
								{ bitrate: 832000, content_type: "video/mp4", url: "lo.mp4" },
								{
									bitrate: 2176000,
									content_type: "video/mp4",
									url: "hi.mp4",
								},
								{ content_type: "application/x-mpegURL", url: "x.m3u8" },
							],
						},
					},
				],
			});
			expect(parsed.mediaDetails?.[0]?.video_info?.variants?.length).toBe(3);
		});

		test("parses multi-photo tweet (4 photos)", () => {
			const parsed = SyndicationResponseSchema.parse({
				id_str: "1",
				mediaDetails: [
					{ type: "photo", media_url_https: "p1.jpg" },
					{ type: "photo", media_url_https: "p2.jpg" },
					{ type: "photo", media_url_https: "p3.jpg" },
					{ type: "photo", media_url_https: "p4.jpg" },
				],
			});
			expect(parsed.mediaDetails?.length).toBe(4);
		});

		test("parses animated_gif as video-shaped detail", () => {
			const parsed = SyndicationResponseSchema.parse({
				id_str: "1",
				mediaDetails: [
					{
						type: "animated_gif",
						video_info: {
							variants: [
								{ content_type: "video/mp4", url: "gif.mp4", bitrate: 0 },
							],
						},
					},
				],
			});
			expect(parsed.mediaDetails?.[0]?.type).toBe("animated_gif");
		});
	});
});
