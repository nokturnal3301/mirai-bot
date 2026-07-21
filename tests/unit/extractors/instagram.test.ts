import { describe, test, expect, spyOn } from "bun:test";
import { InstagramMediaInfoSchema } from "extractors/instagram/schemas";
import { embed, parseEmbedMedia } from "extractors/instagram/strategies/embed";
import {
	buildInstagramMediaPlan,
	extractShortcode,
	findInstagramGraphMedia,
	instagramMediaIdOf,
	parseDashManifest,
} from "extractors/instagram/utils";
import { instagram } from "extractors/instagram/extractor";
import { execute, sequence } from "lib";

describe("instagram", () => {
	describe("extractShortcode", () => {
		test("extracts from /p/ URL", () => {
			const url = "https://instagram.com/p/ABC123xyz";
			expect(extractShortcode(url)).toBe("ABC123xyz");
		});

		test("extracts from /reel/ URL", () => {
			const url = "https://instagram.com/reel/DEF456_abc";
			expect(extractShortcode(url)).toBe("DEF456_abc");
		});

		test("extracts from /reels/ URL", () => {
			const url = "https://instagram.com/reels/GHI789-def";
			expect(extractShortcode(url)).toBe("GHI789-def");
		});

		test("extracts from /tv/ URL", () => {
			const url = "https://instagram.com/tv/JKL012xyz";
			expect(extractShortcode(url)).toBe("JKL012xyz");
		});

		test("handles URL with query params", () => {
			const url = "https://instagram.com/p/ABC123?igsh=xyz";
			expect(extractShortcode(url)).toBe("ABC123");
		});

		test("returns null for invalid URL", () => {
			const url = "https://instagram.com/username";
			expect(extractShortcode(url)).toBeNull();
		});

		test("returns null for non-instagram URL", () => {
			const url = "https://youtube.com/watch?v=abc";
			expect(extractShortcode(url)).toBeNull();
		});
	});

	describe("instagramMediaIdOf", () => {
		test("decodes a shortcode into its numeric media id", () => {
			expect(instagramMediaIdOf("DKVTdMEKcwf")).toBe("3644905042129570847");
		});

		test("rejects characters outside Instagram's alphabet", () => {
			expect(instagramMediaIdOf("bad.code")).toBeNull();
		});
	});

	describe("match", () => {
		test("matches instagram.com/p/ URLs", () => {
			expect(instagram.match("https://instagram.com/p/ABC123")).toBe(true);
		});

		test("matches instagram.com/reel/ URLs", () => {
			expect(instagram.match("https://instagram.com/reel/ABC123")).toBe(true);
		});

		test("matches instagram.com/reels/ URLs", () => {
			expect(instagram.match("https://instagram.com/reels/ABC123")).toBe(true);
		});

		test("matches instagram.com/tv/ URLs", () => {
			expect(instagram.match("https://instagram.com/tv/ABC123")).toBe(true);
		});

		test("does not match profile URLs", () => {
			expect(instagram.match("https://instagram.com/username")).toBe(false);
		});

		test("does not match other domains", () => {
			expect(instagram.match("https://youtube.com/watch?v=abc")).toBe(false);
		});
	});

	describe("parseDashManifest", () => {
		test("prefers an H.264 representation inside the configured quality cap", () => {
			const manifest = `
				<AdaptationSet contentType="audio">
					<Representation><BaseURL>https://cdn.test/audio</BaseURL></Representation>
				</AdaptationSet>
				<AdaptationSet contentType="video">
					<Representation width="720" height="1280" codecs="avc1.64001f"><BaseURL>https://cdn.test/high</BaseURL></Representation>
					<Representation width="360" height="640" codecs="avc1.4d001e"><BaseURL>https://cdn.test/capped</BaseURL></Representation>
				</AdaptationSet>`;

			expect(parseDashManifest(manifest)).toMatchObject({
				videoUrl: "https://cdn.test/capped",
				width: 360,
				height: 640,
				codecCompatible: true,
			});
		});
	});

	describe("normalized strategy payloads", () => {
		test("rejects a cover-only embed payload for a Reel", async () => {
			const context = {
				gql_data: {
					shortcode_media: {
						shortcode: "DbBZDozOtz-",
						display_url: "https://cdn.example/video-cover.jpg",
						dimensions: { width: 720, height: 1280 },
						video_duration: 9,
					},
				},
			};
			const escaped = JSON.stringify(JSON.stringify(context)).slice(1, -1);
			const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(`<script>{"contextJSON":"${escaped}"}</script>`),
			);

			try {
				const result = await execute({
					tag: "instagram-test",
					input: "https://instagram.com/reel/DbBZDozOtz-/",
					plan: sequence([embed.with({ kind: "metadata", cost: "cheap" })]),
				}).run();

				expect(result._tag).toBe("Fail");
				if (result._tag === "Fail") {
					expect(result.error.message).toBe(
						"embed returned only a video cover",
					);
				}
			} finally {
				fetchSpy.mockRestore();
			}
		});

		test("parses graph media from an embed contextJSON payload", () => {
			const context = {
				gql_data: {
					shortcode_media: {
						shortcode: "ABC_123",
						is_video: true,
						video_url: "https://cdn.example/video.mp4",
						display_url: "https://cdn.example/cover.jpg",
						dimensions: { width: 720, height: 1280 },
						owner: { username: "mirai" },
					},
				},
			};
			const escaped = JSON.stringify(JSON.stringify(context)).slice(1, -1);
			const media = parseEmbedMedia(
				`<script>{"contextJSON":"${escaped}"}</script>`,
				"ABC_123",
			);

			expect(media).toMatchObject({
				code: "ABC_123",
				video_versions: [{ url: "https://cdn.example/video.mp4" }],
				owner: { username: "mirai" },
			});
		});

		test("normalizes graph sidecars into one carousel model", () => {
			const media = findInstagramGraphMedia(
				{
					shortcode: "SIDE",
					edge_sidecar_to_children: {
						edges: [
							{ node: { display_url: "https://cdn.example/1.jpg" } },
							{ node: { video_url: "https://cdn.example/2.mp4" } },
						],
					},
				},
				"SIDE",
			);

			expect(media?.carousel_media).toHaveLength(2);
			expect(
				buildInstagramMediaPlan(media as NonNullable<typeof media>),
			).toMatchObject({
				_tag: "Continue",
				value: {
					type: "carousel",
					items: [{ type: "photo" }, { type: "video" }],
				},
			});
		});

		test("validates a mobile media info response", () => {
			const parsed = InstagramMediaInfoSchema.safeParse({
				items: [
					{
						code: "MOBILE",
						video_versions: [{ url: "https://cdn.example/mobile.mp4" }],
					},
				],
			});

			expect(parsed.success).toBe(true);
		});
	});
});
