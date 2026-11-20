import { describe, expect, spyOn, test } from "bun:test";
import { config } from "config";
import { youtube } from "extractors/youtube/extractor";
import { getHttpContext } from "lib/http-context";

const COMBINED_URL = "https://media.example/combined.mp4";
const VIDEO_URL = "https://media.example/adaptive.mp4";
const AUDIO_URL = "https://media.example/audio.m4a";

const playerResponse = () =>
	Response.json({
		playabilityStatus: { status: "OK" },
		streamingData: {
			formats: [
				{
					url: COMBINED_URL,
					mimeType: 'video/mp4; codecs="avc1.4d401e, mp4a.40.2"',
					contentLength: "4",
					height: 720,
				},
			],
			adaptiveFormats: [
				{
					url: VIDEO_URL,
					mimeType: 'video/mp4; codecs="avc1.4d401e"',
					contentLength: "3",
					height: 720,
				},
				{
					url: AUDIO_URL,
					mimeType: 'audio/mp4; codecs="mp4a.40.2"',
					contentLength: "1",
				},
			],
		},
		videoDetails: { title: "Fallback regression", lengthSeconds: "1" },
	});

describe("YouTube download fallback", () => {
	test("downloads and muxes adaptive streams after a combined CDN rejection on the same route", async () => {
		const mediaRequests: string[] = [];
		const sessions = new Set<string | undefined>();
		const engagementSessions: (string | undefined)[] = [];
		let playerRequests = 0;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input,
		) => {
			const url = String(input);
			if (url.includes("/youtubei/v1/next")) {
				engagementSessions.push(getHttpContext()?.proxySession);
				return Response.json({});
			}
			sessions.add(getHttpContext()?.proxySession);
			if (url === "https://www.youtube.com/")
				return new Response('"visitorData":"test"');
			if (url.includes("/youtubei/v1/player")) {
				playerRequests++;
				return playerResponse();
			}
			mediaRequests.push(url);
			if (url === COMBINED_URL) return new Response(null, { status: 403 });
			if (url === VIDEO_URL) return new Response(new Uint8Array([1, 2, 3]));
			if (url === AUDIO_URL) return new Response(new Uint8Array([4]));
			throw new Error(`Unexpected request: ${url}`);
		}) as typeof fetch);
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
			stdout: new Response(new Uint8Array([9, 8, 7])).body,
			stderr: new Response("").body,
			exited: Promise.resolve(0),
			kill: () => {},
		} as unknown as ReturnType<typeof Bun.spawn>);

		try {
			const result = await youtube.extract(
				"https://youtube.com/shorts/fallback001",
			);
			expect(result._tag).toBe("Continue");
			if (result._tag !== "Continue" || result.value.type !== "video") return;
			expect(result.value.data).toBeInstanceOf(Blob);
			expect(await (result.value.data as Blob).bytes()).toEqual(
				new Uint8Array([9, 8, 7]),
			);
			expect(result.value.caption?.text).toBe("Fallback regression");
			expect(playerRequests).toBe(1);
			expect(mediaRequests).toEqual([COMBINED_URL, VIDEO_URL, AUDIO_URL]);
			expect(sessions.size).toBe(1);
			expect(sessions.has(undefined)).toBe(false);
			expect(engagementSessions).toEqual([undefined]);
			expect(spawnSpy).toHaveBeenCalledTimes(1);
		} finally {
			fetchSpy.mockRestore();
			spawnSpy.mockRestore();
		}
	});

	test("stops after an oversized download instead of trying adaptive streams or another route", async () => {
		let playerRequests = 0;
		const mediaRequests: string[] = [];
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input,
		) => {
			const url = String(input);
			if (url === "https://www.youtube.com/")
				return new Response('"visitorData":"test"');
			if (url.includes("/youtubei/v1/next")) return Response.json({});
			if (url.includes("/youtubei/v1/player")) {
				playerRequests++;
				return playerResponse();
			}
			mediaRequests.push(url);
			return new Response(null, {
				headers: { "Content-Length": String(config.telegram.maxFileSize + 1) },
			});
		}) as typeof fetch);

		try {
			const result = await youtube.extract(
				"https://youtube.com/shorts/oversize001",
			);
			expect(result).toMatchObject({
				_tag: "Fail",
				error: { code: "MEDIA_TOO_LARGE", terminal: true },
			});
			expect(playerRequests).toBe(1);
			expect(mediaRequests).toEqual([COMBINED_URL]);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
