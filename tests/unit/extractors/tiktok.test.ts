import { describe, test, expect } from "bun:test";
import { tiktok } from "extractors/tiktok/extractor";
import { solveChallenge } from "extractors/tiktok/utils";
import { SSRItemSchema } from "extractors/tiktok/schemas";
import { videoSourceOf } from "extractors/tiktok/utils";
import {
	buildTikTokMediaPlan,
	imageUrlsOf,
	videoUrlOf,
} from "extractors/tiktok/utils";
import { DOWNLOAD_CONNECTIONS } from "extractors/tiktok/constants";

const buildChallengeHtml = (wci: string, cs: string) =>
	`<div id="wci" class="${wci}"></div><div id="cs" class="${cs}"></div>`;

describe("tiktok", () => {
	describe("solveChallenge", () => {
		test("solves a valid challenge", async () => {
			const cs =
				"eyJ2Ijp7ImEiOiJkR1Z6ZEhCeVpXWnBlQT09IiwiYyI6Im1xVzRRTW9BV0ZHYTVaVExObmpsZWFFdTV4YWxNM2huaHIvZjhBdUpHc0E9In19";
			const html = buildChallengeHtml("_wafchallengeid", cs);

			const result = await solveChallenge(html);

			expect(result).not.toBeNull();
			expect(result).toStartWith("_wafchallengeid=");
		});

		test("solution contains valid base64 JSON with answer", async () => {
			const cs =
				"eyJ2Ijp7ImEiOiJkR1Z6ZEhCeVpXWnBlQT09IiwiYyI6Im1xVzRRTW9BV0ZHYTVaVExObmpsZWFFdTV4YWxNM2huaHIvZjhBdUpHc0E9In19";
			const html = buildChallengeHtml("_wafchallengeid", cs);

			const result = (await solveChallenge(html)) as string;
			const cookieValue = result.split("=").slice(1).join("=");
			const decoded = JSON.parse(Buffer.from(cookieValue, "base64").toString());

			expect(decoded.d).toBeDefined();
			expect(Buffer.from(decoded.d, "base64").toString()).toBe("42");
		});

		test("returns null for missing wci element", async () => {
			const html = '<div id="cs" class="abc"></div>';
			expect(await solveChallenge(html)).toBeNull();
		});

		test("returns null for missing cs element", async () => {
			const html = '<div id="wci" class="cookie_name"></div>';
			expect(await solveChallenge(html)).toBeNull();
		});

		test("returns null for empty html", async () => {
			expect(await solveChallenge("")).toBeNull();
		});
	});

	describe("match", () => {
		test("matches tiktok.com URLs", () => {
			expect(tiktok.match("https://tiktok.com/@user/video/123")).toBe(true);
		});

		test("matches vm.tiktok.com URLs", () => {
			expect(tiktok.match("https://vm.tiktok.com/ABC123")).toBe(true);
		});

		test("matches vt.tiktok.com URLs", () => {
			expect(tiktok.match("https://vt.tiktok.com/ABC123")).toBe(true);
		});

		test("does not match other domains", () => {
			expect(tiktok.match("https://instagram.com/p/abc")).toBe(false);
		});

		test("does not match youtube URLs", () => {
			expect(tiktok.match("https://youtube.com/watch?v=abc")).toBe(false);
		});
	});

	describe("imageUrlsOf", () => {
		test("returns urls for imagePost.images", () => {
			const item = SSRItemSchema.parse({
				imagePost: {
					images: [
						{
							imageURL: {
								urlList: ["https://cdn/1.jpg", "https://cdn/1b.jpg"],
							},
						},
						{ imageURL: { urlList: ["https://cdn/2.jpg"] } },
					],
				},
			});
			expect(imageUrlsOf(item)).toEqual([
				"https://cdn/1.jpg",
				"https://cdn/2.jpg",
			]);
		});

		test("returns empty array when no imagePost", () => {
			const item = SSRItemSchema.parse({});
			expect(imageUrlsOf(item)).toEqual([]);
		});

		test("filters out images with empty urlList", () => {
			const item = SSRItemSchema.parse({
				imagePost: {
					images: [
						{ imageURL: { urlList: [] } },
						{ imageURL: { urlList: ["https://cdn/2.jpg"] } },
					],
				},
			});
			expect(imageUrlsOf(item)).toEqual(["https://cdn/2.jpg"]);
		});
	});

	describe("videoUrlOf", () => {
		test("prefers bitrateInfo PlayAddr URL", () => {
			const item = SSRItemSchema.parse({
				video: {
					bitrateInfo: [{ PlayAddr: { UrlList: ["https://cdn/hi.mp4"] } }],
					playAddr: "https://cdn/fallback.mp4",
				},
			});
			expect(videoUrlOf(item)).toBe("https://cdn/hi.mp4");
		});

		test("falls back to playAddr when no bitrateInfo", () => {
			const item = SSRItemSchema.parse({
				video: { playAddr: "https://cdn/v.mp4" },
			});
			expect(videoUrlOf(item)).toBe("https://cdn/v.mp4");
		});

		test("returns null when video missing", () => {
			const item = SSRItemSchema.parse({});
			expect(videoUrlOf(item)).toBeNull();
		});

		test("returns null when bitrateInfo and playAddr both empty", () => {
			const item = SSRItemSchema.parse({
				video: { bitrateInfo: [] },
			});
			expect(videoUrlOf(item)).toBeNull();
		});
	});

	describe("videoSourceOf", () => {
		test("prefers a fast rendition over the largest fitting variant", () => {
			const item = SSRItemSchema.parse({
				video: {
					width: 1080,
					height: 1920,
					bitrateInfo: [
						{
							Bitrate: 4_000_000,
							PlayAddr: {
								UrlList: ["https://cdn.test/1080.mp4"],
								DataSize: 30 * 1024 * 1024,
								Width: 1080,
								Height: 1920,
							},
						},
						{
							Bitrate: 1_000_000,
							PlayAddr: {
								UrlList: ["https://cdn.test/576.mp4"],
								DataSize: 12 * 1024 * 1024,
								Width: 576,
								Height: 1024,
							},
						},
					],
				},
			});

			expect(videoSourceOf(item)).toMatchObject({
				url: "https://cdn.test/576.mp4",
				width: 576,
				height: 1024,
				size: 12 * 1024 * 1024,
				oversized: false,
			});
		});

		test("normalizes numeric strings from TikTok SSR payloads", () => {
			const item = SSRItemSchema.parse({
				video: {
					width: "1080",
					height: "1920",
					duration: "15",
					bitrateInfo: [
						{
							Bitrate: "1000000",
							PlayAddr: {
								UrlList: ["https://cdn.test/video.mp4"],
								DataSize: "123456",
								Width: "1080",
								Height: "1920",
							},
						},
					],
				},
			});

			expect(item.video).toMatchObject({
				width: 1080,
				height: 1920,
				duration: 15,
				bitrateInfo: [
					{
						Bitrate: 1_000_000,
						PlayAddr: {
							DataSize: 123_456,
							Width: 1080,
							Height: 1920,
						},
					},
				],
			});
		});

		test("rejects non-numeric size strings", () => {
			const result = SSRItemSchema.safeParse({
				video: {
					bitrateInfo: [{ PlayAddr: { DataSize: "unknown" } }],
				},
			});

			expect(result.success).toBe(false);
		});

		test("skips a high-bitrate variant whose declared size exceeds the limit", () => {
			const item = SSRItemSchema.parse({
				video: {
					width: 1080,
					height: 1920,
					bitrateInfo: [
						{
							Bitrate: 5_000_000,
							PlayAddr: {
								UrlList: ["https://cdn.test/high.mp4"],
								DataSize: 100,
							},
						},
						{
							Bitrate: 1_000_000,
							PlayAddr: {
								UrlList: ["https://cdn.test/fitting.mp4"],
								DataSize: 40,
							},
						},
					],
				},
			});

			expect(videoSourceOf(item, 50)).toMatchObject({
				url: "https://cdn.test/fitting.mp4",
				oversized: false,
			});
		});

		test("marks the smallest variant when every declared size is too large", () => {
			const item = SSRItemSchema.parse({
				video: {
					bitrateInfo: [
						{
							PlayAddr: {
								UrlList: ["https://cdn.test/100.mp4"],
								DataSize: 100,
							},
						},
						{
							PlayAddr: {
								UrlList: ["https://cdn.test/80.mp4"],
								DataSize: 80,
							},
						},
					],
				},
			});

			expect(videoSourceOf(item, 50)).toMatchObject({
				url: "https://cdn.test/80.mp4",
				oversized: true,
			});
		});
	});

	describe("buildTikTokMediaPlan", () => {
		test("downloads video direct first, proxy as fallback", () => {
			const item = SSRItemSchema.parse({
				author: { uniqueId: "user" },
				desc: "clip",
				video: {
					width: 720,
					height: 1280,
					bitrateInfo: [
						{
							Bitrate: 1_000_000,
							PlayAddr: {
								UrlList: ["https://cdn.test/video.mp4"],
								DataSize: 5 * 1024 * 1024,
								Width: 720,
								Height: 1280,
							},
						},
					],
				},
			});

			const flow = buildTikTokMediaPlan(item, "sessionid=abc", "page");
			expect(flow._tag).toBe("Continue");
			if (flow._tag !== "Continue") return;
			const plan = flow.value;
			expect(plan.type).toBe("video");
			if (plan.type !== "video") return;
			// Direct datacenter download first (proxy-obtained cookie is not
			// IP-bound), residential proxy only as a fallback.
			expect(plan.source).toMatchObject({
				kind: "fallback",
				sources: [
					{
						kind: "download",
						url: "https://cdn.test/video.mp4",
						connections: DOWNLOAD_CONNECTIONS,
						httpContext: { forceProxy: false },
					},
					{ kind: "download", httpContext: { forceProxy: true } },
				],
			});
		});
	});

	describe("SSRItemSchema music metadata", () => {
		test("parses title, authorName, duration", () => {
			const parsed = SSRItemSchema.parse({
				music: {
					playUrl: "https://cdn/audio.mp3",
					title: "Track",
					authorName: "Artist",
					duration: 30,
				},
			});
			expect(parsed.music?.title).toBe("Track");
			expect(parsed.music?.authorName).toBe("Artist");
			expect(parsed.music?.duration).toBe(30);
		});

		test("allows music object with only playUrl", () => {
			const parsed = SSRItemSchema.parse({
				music: { playUrl: "https://cdn/audio.mp3" },
			});
			expect(parsed.music?.playUrl).toBe("https://cdn/audio.mp3");
			expect(parsed.music?.title).toBeUndefined();
		});
	});
});
