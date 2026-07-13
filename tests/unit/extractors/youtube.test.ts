import { describe, expect, spyOn, test } from "bun:test";
import { extractVideoId } from "extractors/youtube/utils";
import { youtube } from "extractors/youtube/extractor";

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
				expect(mediaUserAgent ?? "").toContain("youtube.vr.oculus");
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

		test("rerolls the sticky route after a media download failure", async () => {
			const mediaUrl = "https://media.example/unavailable.mp4";
			let playerRequests = 0;
			let mediaRequests = 0;
			const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
				input,
			) => {
				const url = String(input);
				if (url === "https://www.youtube.com/") {
					return new Response('"visitorData":"visitor-id"');
				}
				if (url === mediaUrl) {
					mediaRequests++;
					return new Response(null, { status: 503 });
				}

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
					},
				});
			}) as typeof fetch);

			try {
				const result = await youtube.extract(
					"https://youtube.com/shorts/badMedia001",
				);

				expect(result._tag).toBe("Fail");
				expect(playerRequests).toBe(3);
				expect(mediaRequests).toBe(3);
			} finally {
				fetchSpy.mockRestore();
			}
		});
	});
});
