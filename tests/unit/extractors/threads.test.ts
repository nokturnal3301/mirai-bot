import { describe, test, expect } from "bun:test";
import { threads } from "extractors/threads/extractor";
import { extractPostCode } from "extractors/threads/utils";
import { ThreadsPostSchema } from "extractors/threads/schemas";

describe("threads", () => {
	describe("match", () => {
		test("matches threads.com URLs", () => {
			expect(threads.match("https://www.threads.com/@user/post/ABC123")).toBe(
				true,
			);
		});

		test("matches threads.net URLs", () => {
			expect(threads.match("https://www.threads.net/@user/post/ABC")).toBe(
				true,
			);
		});

		test("matches usernames with dots/dashes", () => {
			expect(
				threads.match("https://www.threads.com/@user.name-1/post/ABC"),
			).toBe(true);
		});

		test("does not match profile URLs", () => {
			expect(threads.match("https://www.threads.com/@user")).toBe(false);
		});

		test("does not match other domains", () => {
			expect(threads.match("https://instagram.com/p/abc")).toBe(false);
		});
	});

	describe("extractPostCode", () => {
		test("extracts from threads.com URL", () => {
			expect(
				extractPostCode("https://www.threads.com/@user/post/ABC_xyz-1"),
			).toBe("ABC_xyz-1");
		});

		test("extracts from threads.net URL", () => {
			expect(extractPostCode("https://www.threads.net/@user/post/DEFGHI")).toBe(
				"DEFGHI",
			);
		});

		test("returns null for profile URL", () => {
			expect(extractPostCode("https://www.threads.com/@user")).toBeNull();
		});

		test("returns null for non-threads URL", () => {
			expect(extractPostCode("https://instagram.com/p/abc")).toBeNull();
		});
	});

	describe("ThreadsPostSchema", () => {
		test("parses video post", () => {
			const parsed = ThreadsPostSchema.parse({
				code: "ABC",
				media_type: 2,
				video_versions: [
					{ url: "https://cdn/v.mp4", width: 720, height: 1280 },
				],
				original_width: 720,
				original_height: 1280,
				video_duration: 12.5,
			});
			expect(parsed.video_versions?.[0]?.url).toBe("https://cdn/v.mp4");
			expect(parsed.video_duration).toBe(12.5);
		});

		test("parses carousel post", () => {
			const parsed = ThreadsPostSchema.parse({
				code: "ABC",
				carousel_media: [
					{
						media_type: 1,
						image_versions2: {
							candidates: [
								{ url: "https://cdn/1.jpg", width: 1080, height: 1080 },
							],
						},
					},
					{
						media_type: 2,
						video_versions: [{ url: "https://cdn/2.mp4" }],
					},
				],
			});
			expect(parsed.carousel_media?.length).toBe(2);
			expect(
				parsed.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url,
			).toBe("https://cdn/1.jpg");
			expect(parsed.carousel_media?.[1]?.video_versions?.[0]?.url).toBe(
				"https://cdn/2.mp4",
			);
		});

		test("parses photo post (no video)", () => {
			const parsed = ThreadsPostSchema.parse({
				code: "ABC",
				media_type: 1,
				image_versions2: {
					candidates: [
						{ url: "https://cdn/lg.jpg", width: 1080, height: 1080 },
						{ url: "https://cdn/sm.jpg", width: 320, height: 320 },
					],
				},
			});
			expect(parsed.image_versions2?.candidates?.length).toBe(2);
			expect(parsed.video_versions).toBeUndefined();
		});
	});
});
