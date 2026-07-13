import { describe, expect, test } from "bun:test";
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
			},
		});
	});
});
