import { describe, expect, spyOn, test } from "bun:test";
import { materializeMedia, type MediaPlan } from "extractors/media";

describe("media plans", () => {
	test("keeps a remote video deferred until Telegram delivery", async () => {
		const plan: MediaPlan = {
			type: "video",
			source: {
				kind: "remote",
				url: "https://cdn.example/video.mp4",
				headers: { Referer: "https://example.com/" },
				telegramFetch: false,
			},
			width: 720,
			height: 1280,
		};

		const result = await materializeMedia(plan);

		expect(result).toEqual({
			_tag: "Continue",
			value: {
				type: "video",
				data: {
					kind: "remote",
					url: "https://cdn.example/video.mp4",
					headers: { Referer: "https://example.com/" },
					telegramFetch: false,
				},
				width: 720,
				height: 1280,
			},
		});
	});

	test("downloads a carousel's soundtrack alongside its photos", async () => {
		let audioRequested = () => {};
		const audioStarted = new Promise<void>((resolve) => {
			audioRequested = resolve;
		});
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: RequestInfo | URL,
		) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("track")) {
				audioRequested();
				return new Response("audio", {
					headers: { "content-type": "audio/mpeg" },
				});
			}
			await Promise.race([audioStarted, Bun.sleep(1_000)]);
			return new Response("photo", {
				headers: { "content-type": "image/jpeg" },
			});
		}) as typeof fetch);

		try {
			const startedAt = performance.now();
			const result = await materializeMedia({
				type: "carousel",
				items: [
					{
						type: "photo",
						source: { kind: "download", url: "https://cdn.example/1.jpg" },
					},
				],
				audio: {
					source: { kind: "download", url: "https://cdn.example/track.mp3" },
					title: "Track",
				},
			});

			expect(performance.now() - startedAt).toBeLessThan(900);
			expect(result).toMatchObject({
				_tag: "Continue",
				value: { type: "carousel", items: [{ type: "photo" }] },
			});
			if (result._tag === "Continue" && result.value.type === "carousel") {
				expect(result.value.audio?.title).toBe("Track");
				expect(result.value.audio?.data).toBeInstanceOf(Blob);
			}
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("downloads several carousel photos at once", async () => {
		let inFlight = 0;
		let peak = 0;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			_input: RequestInfo | URL,
		) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await Bun.sleep(20);
			inFlight--;
			return new Response("photo", {
				headers: { "content-type": "image/jpeg" },
			});
		}) as typeof fetch);

		try {
			const result = await materializeMedia({
				type: "carousel",
				items: Array.from({ length: 8 }, (_, index) => ({
					type: "photo" as const,
					source: {
						kind: "download" as const,
						url: `https://cdn.example/${index}.jpg`,
					},
				})),
			});

			expect(result._tag).toBe("Continue");
			expect(peak).toBe(6);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("materializes ready media without I/O", async () => {
		const data = new Blob(["photo"], { type: "image/jpeg" });
		const result = await materializeMedia({
			type: "photo",
			source: { kind: "ready", data },
			caption: { author: "mirai" },
		});

		expect(result).toEqual({
			_tag: "Continue",
			value: {
				type: "photo",
				data,
				caption: { author: "mirai" },
			},
		});
	});

	test("materializes the first usable video source", async () => {
		const data = new Blob(["fallback"]);
		const result = await materializeMedia({
			type: "video",
			source: {
				kind: "fallback",
				sources: [
					{
						kind: "mux",
						videoUrl: "not-a-url",
						audioUrl: "not-a-url",
					},
					{ kind: "ready", data },
				],
			},
		});

		expect(result).toEqual({
			_tag: "Continue",
			value: { type: "video", data },
		});
	});

	test("drops failed carousel items while preserving source order", async () => {
		const first = new Blob(["first"]);
		const second = new Blob(["second"]);
		const result = await materializeMedia({
			type: "carousel",
			items: [
				{ type: "photo", source: { kind: "ready", data: first } },
				{
					type: "video",
					source: {
						kind: "mux",
						videoUrl: "not-a-url",
						audioUrl: "not-a-url",
					},
				},
				{ type: "photo", source: { kind: "ready", data: second } },
			],
		});

		expect(result).toEqual({
			_tag: "Continue",
			value: {
				type: "carousel",
				items: [
					{ type: "photo", data: first },
					{ type: "photo", data: second },
				],
				total: 3,
			},
		});
	});

	test("reports the full item count only when the carousel is incomplete", async () => {
		const result = await materializeMedia({
			type: "carousel",
			items: [
				{ type: "photo", source: { kind: "ready", data: new Blob(["a"]) } },
				{ type: "photo", source: { kind: "ready", data: new Blob(["b"]) } },
			],
		});

		expect(result._tag).toBe("Continue");
		if (result._tag === "Continue" && result.value.type === "carousel") {
			expect(result.value.total).toBeUndefined();
		}
	});
});
