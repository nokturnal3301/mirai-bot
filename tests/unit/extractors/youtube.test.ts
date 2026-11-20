import { describe, expect, spyOn, test } from "bun:test";
import type { StrategyContext } from "lib";
import {
	captionOf,
	extractVideoId,
	parseCount,
	parseEngagement,
	parsePublishDate,
} from "extractors/youtube/utils";
import { youtube } from "extractors/youtube/extractor";
import { adaptive } from "extractors/youtube/strategies/adaptive";

const NEXT_URL = "https://www.youtube.com/youtubei/v1/next?prettyPrint=false";

const nextResponse = () => ({
	contents: {
		twoColumnWatchNextResults: {
			results: {
				results: {
					contents: [
						{
							videoPrimaryInfoRenderer: {
								dateText: { simpleText: "Sep 17, 2026" },
							},
						},
					],
				},
			},
		},
	},
	engagementPanels: [
		{
			engagementPanelSectionListRenderer: {
				panelIdentifier: "engagement-panel-comments-section",
				header: {
					engagementPanelTitleHeaderRenderer: {
						contextualInfo: { runs: [{ text: "8K" }] },
					},
				},
			},
		},
	],
	likeButton: {
		accessibilityText: "like this video along with 506,923 other people",
	},
});

describe("youtube", () => {
	describe("extractVideoId", () => {
		test("extracts from watch URL", () => {
			const url = "https://youtube.com/watch?v=dQw4w9WgXcQ";
			expect(extractVideoId(url)).toBe("dQw4w9WgXcQ");
		});

		test("extracts from shorts URL", () => {
			const url = "https://youtube.com/shorts/dQw4w9WgXcQ";
			expect(extractVideoId(url)).toBe("dQw4w9WgXcQ");
		});

		test("extracts from youtu.be URL", () => {
			const url = "https://youtu.be/dQw4w9WgXcQ";
			expect(extractVideoId(url)).toBe("dQw4w9WgXcQ");
		});

		test("handles URL with extra params", () => {
			const url = "https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s";
			expect(extractVideoId(url)).toBe("dQw4w9WgXcQ");
		});

		test("returns null for invalid URL", () => {
			const url = "https://youtube.com/channel/UC123";
			expect(extractVideoId(url)).toBeNull();
		});

		test("returns null for non-youtube URL", () => {
			const url = "https://instagram.com/p/ABC123";
			expect(extractVideoId(url)).toBeNull();
		});

		test("handles video ID with underscores and dashes", () => {
			const url = "https://youtu.be/a_B-c1D2e3F";
			expect(extractVideoId(url)).toBe("a_B-c1D2e3F");
		});
	});

	describe("match", () => {
		test("matches youtube.com/shorts URLs", () => {
			expect(youtube.match("https://youtube.com/shorts/abc123")).toBe(true);
		});

		test("does not match youtube.com/watch URLs", () => {
			expect(youtube.match("https://youtube.com/watch?v=abc123")).toBe(false);
		});

		test("does not match youtu.be URLs", () => {
			expect(youtube.match("https://youtu.be/abc123")).toBe(false);
		});

		test("does not match channel URLs", () => {
			expect(youtube.match("https://youtube.com/channel/UC123")).toBe(false);
		});

		test("does not match other domains", () => {
			expect(youtube.match("https://instagram.com/p/abc")).toBe(false);
		});
	});

	describe("extraction", () => {
		test("prefers original audio over a higher-bitrate auto-dub", async () => {
			const originalAudioUrl = "https://media.example/original.m4a";
			const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
				input,
			) => {
				if (String(input) === "https://www.youtube.com/") {
					return new Response('"visitorData":"visitor-id"');
				}
				return Response.json({
					playabilityStatus: { status: "OK" },
					streamingData: {
						adaptiveFormats: [
							{
								url: "https://media.example/video.mp4",
								mimeType: 'video/mp4; codecs="avc1.4d401f"',
								width: 720,
								height: 1280,
								contentLength: "9280000",
							},
							{
								url: "https://media.example/dubbed.m4a",
								mimeType: 'audio/mp4; codecs="mp4a.40.2"',
								bitrate: 192_000,
								audioTrack: {
									displayName: "English (US)",
									id: "en-US.10",
									audioIsDefault: false,
									isAutoDubbed: true,
								},
							},
							{
								url: originalAudioUrl,
								mimeType: 'audio/mp4; codecs="mp4a.40.2"',
								bitrate: 128_000,
								contentLength: "2480000",
								audioTrack: {
									displayName: "Russian original",
									id: "ru.4",
									audioIsDefault: true,
								},
							},
						],
					},
					videoDetails: { lengthSeconds: "10" },
				});
			}) as typeof fetch);
			const signal = new AbortController().signal;
			const context: StrategyContext = {
				signal,
				resolve: (_fact, load) => load(signal),
			};

			try {
				const result = await adaptive
					.with({ kind: "fallback", cost: "expensive" })
					.execute("https://youtube.com/shorts/audioTrack1", context);

				expect(result._tag).toBe("Continue");
				if (result._tag !== "Continue" || result.value.type !== "video") return;
				expect(result.value.source.kind).toBe("mux");
				if (result.value.source.kind !== "mux") return;
				expect(result.value.source.audioUrl).toBe(originalAudioUrl);
				expect(result.value.source.videoBytes).toBe(9_280_000);
				expect(result.value.source.audioBytes).toBe(2_480_000);
			} finally {
				fetchSpy.mockRestore();
			}
		});

		test("downloads media inside the sticky route attempt", async () => {
			const mediaUrl = "https://media.example/short.mp4";
			let mediaUserAgent: string | null = null;
			const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
				input,
				init,
			) => {
				const url = String(input);
				if (url === "https://www.youtube.com/") {
					return new Response('"visitorData":"visitor-id"');
				}
				if (url === mediaUrl) {
					mediaUserAgent = new Headers(init?.headers).get("user-agent");
					return new Response(new Uint8Array(1024), {
						headers: { "Content-Type": "video/mp4" },
					});
				}
				return Response.json({
					playabilityStatus: { status: "OK" },
					streamingData: {
						formats: [
							{
								url: mediaUrl,
								mimeType: 'video/mp4; codecs="avc1.4d401e, mp4a.40.2"',
								width: 720,
								height: 1280,
								contentLength: "1024",
							},
						],
					},
					videoDetails: { title: "Short", lengthSeconds: "10" },
				});
			}) as typeof fetch);

			try {
				const result = await youtube.extract(
					"https://youtube.com/shorts/routeBound1",
				);

				expect(result._tag).toBe("Continue");
				if (result._tag !== "Continue" || result.value.type !== "video") return;
				expect(result.value.data).toBeInstanceOf(Blob);
				expect((result.value.data as Blob).size).toBe(1024);
				expect(mediaUserAgent ?? "").toContain("Version/26.0 Safari");
			} finally {
				fetchSpy.mockRestore();
			}
		});

		test("rerolls the sticky route without repeating a transport failure", async () => {
			let playerRequests = 0;
			const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
				input,
			) => {
				const url = String(input);
				if (url === "https://www.youtube.com/") {
					return new Response('"visitorData":"visitor-id"');
				}
				if (url === NEXT_URL) return Response.json({});
				playerRequests++;
				return new Response(null, { status: 503 });
			}) as typeof fetch);

			try {
				const result = await youtube.extract(
					"https://youtube.com/shorts/deadRoute01",
				);

				expect(result._tag).toBe("Fail");
				expect(playerRequests).toBe(3);
			} finally {
				fetchSpy.mockRestore();
			}
		});

		test("rerolls the sticky route after both combined and adaptive downloads fail", async () => {
			const mediaUrl = "https://media.example/unavailable.mp4";
			const audioUrl = "https://media.example/unavailable.m4a";
			let playerRequests = 0;
			let mediaRequests = 0;
			const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
				input,
			) => {
				const url = String(input);
				if (url === "https://www.youtube.com/") {
					return new Response('"visitorData":"visitor-id"');
				}
				if (url === mediaUrl || url === audioUrl) {
					mediaRequests++;
					return new Response(null, { status: 503 });
				}
				if (url === NEXT_URL) return Response.json({});

				playerRequests++;
				return Response.json({
					playabilityStatus: { status: "OK" },
					streamingData: {
						formats: [
							{
								url: mediaUrl,
								mimeType: "video/mp4",
								contentLength: "1024",
							},
						],
						adaptiveFormats: [
							{ url: mediaUrl, mimeType: 'video/mp4; codecs="avc1.4d401e"' },
							{ url: audioUrl, mimeType: 'audio/mp4; codecs="mp4a.40.2"' },
						],
					},
				});
			}) as typeof fetch);

			try {
				const result = await youtube.extract(
					"https://youtube.com/shorts/badMedia001",
				);

				expect(result._tag).toBe("Fail");
				expect(playerRequests).toBe(3);
				expect(mediaRequests).toBe(9);
			} finally {
				fetchSpy.mockRestore();
			}
		});

		const mockShort = (
			next: (signal?: AbortSignal | null) => Promise<Response>,
		) => {
			const mediaUrl = "https://media.example/engaged.mp4";
			return spyOn(globalThis, "fetch").mockImplementation((async (
				input,
				init,
			) => {
				const url = String(input);
				if (url === "https://www.youtube.com/") {
					return new Response('"visitorData":"visitor-id"');
				}
				if (url === NEXT_URL) return next(init?.signal);
				if (url === mediaUrl) {
					return new Response(new Uint8Array(1024), {
						headers: { "Content-Type": "video/mp4" },
					});
				}
				return Response.json({
					playabilityStatus: { status: "OK" },
					streamingData: {
						formats: [
							{
								url: mediaUrl,
								mimeType: 'video/mp4; codecs="avc1.4d401e, mp4a.40.2"',
								width: 720,
								height: 1280,
								contentLength: "1024",
							},
						],
					},
					videoDetails: {
						title: "He woke me up for this",
						shortDescription: "#jackson #parrot",
						author: "Jackson Huhniverses",
						viewCount: "12544471",
						lengthSeconds: "10",
					},
				});
			}) as typeof fetch);
		};

		test("adds likes, comments and the date from the watch page", async () => {
			const fetchSpy = mockShort(async () => Response.json(nextResponse()));
			try {
				const result = await youtube.extract(
					"https://youtube.com/shorts/engaged0001",
				);
				expect(result._tag).toBe("Continue");
				if (result._tag !== "Continue" || result.value.type !== "video") return;
				expect(result.value.caption).toEqual({
					name: "Jackson Huhniverses",
					text: "He woke me up for this\n\n#jackson #parrot",
					stats: { views: 12544471, likes: 506923, comments: 8000 },
					postedAt: Date.UTC(2026, 8, 17, 12) / 1000,
				});
			} finally {
				fetchSpy.mockRestore();
			}
		});

		test("delivers without engagement when the watch page is slow", async () => {
			let aborted = false;
			const fetchSpy = mockShort(
				(signal) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => {
							aborted = true;
							reject(new Error("aborted"));
						});
					}),
			);
			try {
				const startedAt = performance.now();
				const result = await youtube.extract(
					"https://youtube.com/shorts/slowNext001",
				);
				expect(performance.now() - startedAt).toBeLessThan(2_000);
				expect(result._tag).toBe("Continue");
				if (result._tag !== "Continue" || result.value.type !== "video") return;
				expect(result.value.caption?.stats).toEqual({ views: 12544471 });
				expect(result.value.caption?.postedAt).toBeUndefined();
				expect(aborted).toBe(true);
			} finally {
				fetchSpy.mockRestore();
			}
		});
	});

	describe("captionOf", () => {
		test("names the channel without a handle and joins title with description", () => {
			expect(
				captionOf({
					videoDetails: {
						title: " Title ",
						shortDescription: "  ",
						author: "Linus Tech Tips",
						viewCount: "42",
					},
				}),
			).toEqual({
				name: "Linus Tech Tips",
				text: "Title",
				stats: { views: 42 },
			});
			expect(captionOf({}).stats).toBeUndefined();
		});
	});

	describe("engagement parsing", () => {
		test("parses exact and compact counts", () => {
			expect(parseCount("506,923")).toBe(506923);
			expect(parseCount("8K")).toBe(8000);
			expect(parseCount("2.4M")).toBe(2_400_000);
			expect(parseCount("1.2b")).toBe(1_200_000_000);
			expect(parseCount("No comments")).toBeUndefined();
			expect(parseCount(undefined)).toBeUndefined();
		});

		test("parses publish dates at noon UTC", () => {
			expect(parsePublishDate("Sep 17, 2026")).toBe(
				Date.UTC(2026, 8, 17, 12) / 1000,
			);
			expect(parsePublishDate("Premiered Oct 24, 2009")).toBe(
				Date.UTC(2009, 9, 24, 12) / 1000,
			);
			expect(parsePublishDate("2 months ago")).toBeUndefined();
		});

		test("prefers the exact like count over accessibility text", () => {
			const text = JSON.stringify({
				...nextResponse(),
				likeCountEntity: { likeCountIfIndifferentNumber: "19512435" },
			});
			expect(parseEngagement(text)).toEqual({
				likes: 19512435,
				comments: 8000,
				postedAt: Date.UTC(2026, 8, 17, 12) / 1000,
			});
		});

		test("tolerates unrelated or broken responses", () => {
			expect(parseEngagement("not json")).toEqual({ likes: undefined });
			expect(parseEngagement(JSON.stringify({ contents: 5 }))).toEqual({
				likes: undefined,
			});
			expect(parseEngagement("{}")).toEqual({
				likes: undefined,
				comments: undefined,
				postedAt: undefined,
			});
		});
	});
});
