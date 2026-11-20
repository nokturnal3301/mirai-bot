import { describe, test, expect, spyOn } from "bun:test";
import { InstagramMediaInfoSchema } from "extractors/instagram/schemas";
import { embed, parseEmbedMedia } from "extractors/instagram/strategies/embed";
import { graphql } from "extractors/instagram/strategies/graphql";
import {
	buildInstagramMediaPlan,
	extractShortcode,
	findInstagramGraphMedia,
	instagramCaptionOf,
	instagramMediaIdOf,
	parseDashManifest,
} from "extractors/instagram/utils";
import { instagram } from "extractors/instagram/extractor";
import { execute, sequence, withHttpContext } from "lib";

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
		test("retries region-muted videos through the proxy", async () => {
			const media = {
				media_type: 2,
				has_audio: false,
				video_versions: [{ url: "https://cdn.example/silent.mp4" }],
				clips_metadata: {
					music_info: {
						music_consumption_info: {
							should_mute_audio: true,
							should_mute_audio_reason: "licensing restriction",
						},
					},
				},
			};

			const direct = buildInstagramMediaPlan(media);
			expect(direct).toMatchObject({
				_tag: "Fail",
				error: {
					code: "UPSTREAM_REJECTED",
					message: "licensing restriction",
					retryable: true,
				},
			});

			const proxied = await withHttpContext({ forceProxy: true }, async () =>
				buildInstagramMediaPlan(media),
			);
			expect(proxied).toMatchObject({
				_tag: "Fail",
				error: { code: "UPSTREAM_REJECTED", retryable: true },
			});
		});

		test("does not retry age-restricted GraphQL media", async () => {
			const fetchSpy = spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(new Response('["LSD",[],{"token":"abc"}]'))
				.mockResolvedValueOnce(
					Response.json({
						data: {
							xig_polaris_media: {
								gating_ruling: { gating_type: 3 },
							},
						},
					}),
				);

			try {
				const result = await execute({
					tag: "instagram-test",
					input: "https://instagram.com/reel/RESTRICTED/",
					plan: sequence([
						graphql.with({ kind: "fallback", cost: "expensive" }),
					]),
				}).run();

				expect(result).toEqual({
					_tag: "Fail",
					error: {
						code: "AGE_RESTRICTED",
						message: "Instagram requires login for age-restricted content",
						retryable: false,
						terminal: true,
					},
				});
			} finally {
				fetchSpy.mockRestore();
			}
		});

		test("rejects a cover-only embed payload for a /p/ video", async () => {
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
					input: "https://instagram.com/p/DbBZDozOtz-/",
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

		test("builds a caption with profile, stats, date and licensed track", () => {
			expect(
				instagramCaptionOf({
					media_type: 2,
					video_versions: [{ url: "https://cdn.example/reel.mp4" }],
					user: {
						username: "minimonkeydancing",
						full_name: "Monkeyman",
						is_verified: true,
					},
					caption: { text: "I love you like a love song" },
					taken_at: 1794738049,
					like_count: 42225,
					comment_count: 83,
					play_count: 190647,
					clips_metadata: {
						music_info: {
							music_asset_info: {
								title: "Love You Like A Love Song",
								display_artist: "Selena Gomez &amp; The Scene",
							},
						},
					},
				}),
			).toEqual({
				author: "minimonkeydancing",
				name: "Monkeyman",
				verified: true,
				text: "I love you like a love song",
				stats: { views: 190647, likes: 42225, comments: 83 },
				postedAt: 1794738049,
				music: "Love You Like A Love Song — Selena Gomez & The Scene",
			});
		});

		test("hides likes and views the author disabled and skips photo views", () => {
			expect(
				instagramCaptionOf({
					image_versions2: {
						candidates: [{ url: "https://cdn.example/1.jpg" }],
					},
					user: { username: "mirai", is_verified: false },
					like_count: 10,
					comment_count: 2,
					view_count: 99,
					like_and_view_counts_disabled: true,
				}),
			).toEqual({ author: "mirai", stats: { comments: 2 } });
		});

		test("keeps graph counts, views and original audio through normalization", () => {
			const media = findInstagramGraphMedia(
				{
					shortcode: "REEL",
					is_video: true,
					video_url: "https://cdn.example/reel.mp4",
					owner: { username: "cheekyboyos", is_verified: true },
					video_view_count: 588573,
					edge_liked_by: { count: 78347 },
					edge_media_to_comment: { count: 946 },
					clips_music_attribution_info: {
						artist_name: "cheekyboyos",
						song_name: "Original audio",
						uses_original_audio: true,
					},
				},
				"REEL",
			);

			expect(
				buildInstagramMediaPlan(media as NonNullable<typeof media>),
			).toMatchObject({
				_tag: "Continue",
				value: {
					type: "video",
					caption: {
						author: "cheekyboyos",
						verified: true,
						stats: { views: 588573, likes: 78347, comments: 946 },
						music: "Original audio — cheekyboyos",
					},
				},
			});
		});

		test("sends a photo post's licensed track after the photo", () => {
			const plan = buildInstagramMediaPlan({
				media_type: 1,
				image_versions2: { candidates: [{ url: "https://cdn.example/1.jpg" }] },
				music_metadata: {
					music_info: {
						music_asset_info: {
							title: "Мій рід",
							display_artist: "Artem Pivovarov",
							progressive_download_url: "https://cdn.example/track.m4a",
							duration_in_ms: 30_400,
						},
					},
				},
			});

			expect(plan).toMatchObject({
				_tag: "Continue",
				value: {
					type: "carousel",
					items: [
						{ type: "photo", source: { httpContext: { forceProxy: false } } },
					],
					caption: { music: "Мій рід — Artem Pivovarov" },
					audio: {
						source: {
							kind: "download",
							url: "https://cdn.example/track.m4a",
							httpContext: { forceProxy: false },
						},
						duration: 30,
						title: "Мій рід",
						performer: "Artem Pivovarov",
					},
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
