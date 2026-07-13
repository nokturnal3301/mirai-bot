import { describe, test, expect } from "bun:test";
import { reddit } from "extractors/reddit/extractor";
import {
	decodeHtmlEntities,
	extractIReddId,
	extractPostId,
	extractShortId,
	extractVReddId,
	isNativeMediaUrl,
	shredditUrlOf,
} from "extractors/reddit/utils";
import { RedditListingSchema } from "extractors/reddit/schemas";

describe("reddit", () => {
	describe("match", () => {
		test("matches subreddit post URLs", () => {
			expect(
				reddit.match("https://www.reddit.com/r/aww/comments/abc123/cute_dog/"),
			).toBe(true);
		});

		test("matches reddit.com/comments/ URLs (no subreddit)", () => {
			expect(reddit.match("https://reddit.com/comments/abc123/")).toBe(true);
		});

		test("matches redd.it short URLs", () => {
			expect(reddit.match("https://redd.it/abc123")).toBe(true);
		});

		test("matches v.redd.it URLs", () => {
			expect(reddit.match("https://v.redd.it/abcdef")).toBe(true);
		});

		test("matches i.redd.it URLs", () => {
			expect(reddit.match("https://i.redd.it/foo.jpg")).toBe(true);
		});

		test("does not match other domains", () => {
			expect(reddit.match("https://example.com/r/aww")).toBe(false);
		});

		test("does not match reddit profile URLs", () => {
			expect(reddit.match("https://reddit.com/user/foo")).toBe(false);
		});
	});

	describe("extractPostId", () => {
		test("extracts from /r/sub/comments/ URL", () => {
			expect(
				extractPostId("https://reddit.com/r/aww/comments/abc123/cute_dog/"),
			).toBe("abc123");
		});

		test("extracts from /comments/ URL without subreddit", () => {
			expect(extractPostId("https://reddit.com/comments/xyz/")).toBe("xyz");
		});

		test("returns null for short URL", () => {
			expect(extractPostId("https://redd.it/abc")).toBeNull();
		});

		test("returns null for non-post URL", () => {
			expect(extractPostId("https://reddit.com/r/aww")).toBeNull();
		});
	});

	describe("extractShortId / VReddId / IReddId", () => {
		test("short", () => {
			expect(extractShortId("https://redd.it/abc123")).toBe("abc123");
			expect(extractShortId("https://reddit.com/r/x/comments/y/")).toBeNull();
		});
		test("vredd", () => {
			expect(extractVReddId("https://v.redd.it/xyz789")).toBe("xyz789");
		});
		test("iredd", () => {
			expect(extractIReddId("https://i.redd.it/pic.jpg")).toBe("pic");
		});
	});

	describe("isNativeMediaUrl", () => {
		test("true for i.redd.it/v.redd.it", () => {
			expect(isNativeMediaUrl("https://i.redd.it/foo.jpg")).toBe(true);
			expect(isNativeMediaUrl("https://v.redd.it/bar")).toBe(true);
		});

		test("true for reddit.com/gallery", () => {
			expect(isNativeMediaUrl("https://www.reddit.com/gallery/abc")).toBe(true);
		});

		test("false for youtube/imgur/external", () => {
			expect(isNativeMediaUrl("https://youtube.com/watch?v=x")).toBe(false);
			expect(isNativeMediaUrl("https://imgur.com/abc")).toBe(false);
			expect(isNativeMediaUrl("https://example.com")).toBe(false);
		});
	});

	describe("decodeHtmlEntities", () => {
		test("decodes &amp;", () => {
			expect(decodeHtmlEntities("foo&amp;bar=1")).toBe("foo&bar=1");
		});

		test("decodes &#x27; and &quot;", () => {
			expect(decodeHtmlEntities("it&#x27;s &quot;ok&quot;")).toBe('it\'s "ok"');
		});
	});

	describe("shredditUrlOf", () => {
		test("builds a partial-render session bootstrap URL", () => {
			const result = shredditUrlOf(
				"https://www.reddit.com/r/test/comments/abc123/title/",
			);
			const url = new URL(result as string);

			expect(url.pathname).toBe("/svc/shreddit/r/test/comments/abc123/title");
			expect(url.searchParams.get("render-mode")).toBe("partial");
			expect(url.searchParams.get("seeker-session")).toBe("false");
		});
	});

	describe("RedditListingSchema", () => {
		test("parses gallery post", () => {
			const fixture = [
				{
					data: {
						children: [
							{
								data: {
									is_gallery: true,
									gallery_data: {
										items: [{ media_id: "img1" }, { media_id: "img2" }],
									},
									media_metadata: {
										img1: {
											status: "valid",
											m: "image/jpg",
											s: {
												u: "https://preview.redd.it/img1.jpg",
												x: 1080,
												y: 1920,
											},
										},
										img2: {
											status: "valid",
											m: "image/jpg",
											s: { u: "https://preview.redd.it/img2.jpg" },
										},
									},
								},
							},
						],
					},
				},
			];

			const parsed = RedditListingSchema.parse(fixture);
			const post = parsed[0]?.data?.children?.[0]?.data;
			expect(post?.is_gallery).toBe(true);
			expect(post?.gallery_data?.items?.length).toBe(2);
			expect(post?.media_metadata?.img1?.s?.u).toContain("img1.jpg");
		});

		test("parses video post", () => {
			const fixture = [
				{
					data: {
						children: [
							{
								data: {
									is_video: true,
									media: {
										reddit_video: {
											fallback_url:
												"https://v.redd.it/abc/DASH_720.mp4?source=fallback",
											width: 1280,
											height: 720,
											duration: 30,
										},
									},
								},
							},
						],
					},
				},
			];

			const post =
				RedditListingSchema.parse(fixture)[0]?.data?.children?.[0]?.data;
			expect(post?.is_video).toBe(true);
			expect(post?.media?.reddit_video?.fallback_url).toContain("DASH_720.mp4");
			expect(post?.media?.reddit_video?.duration).toBe(30);
		});

		test("parses image post with preview", () => {
			const fixture = [
				{
					data: {
						children: [
							{
								data: {
									url: "https://i.redd.it/cute.jpg",
									preview: {
										images: [{ source: { width: 1080, height: 1080 } }],
									},
								},
							},
						],
					},
				},
			];

			const post =
				RedditListingSchema.parse(fixture)[0]?.data?.children?.[0]?.data;
			expect(post?.url).toBe("https://i.redd.it/cute.jpg");
			expect(post?.preview?.images?.[0]?.source?.width).toBe(1080);
		});
	});
});
