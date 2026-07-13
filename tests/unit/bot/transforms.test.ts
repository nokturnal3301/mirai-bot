import { describe, test, expect } from "bun:test";
import { checkFileSize, matchExtractor, detectUrl } from "bot/transforms";
import type { MessageContext } from "bot/types";

const mockCtx = (text: string) =>
	({
		text,
		chat: { id: 123, type: "private" },
		from: { id: 456, username: "testuser" },
	}) as unknown as MessageContext;

describe("detectUrl", () => {
	test("returns Continue with URL when found", () => {
		const ctx = mockCtx("Check this https://example.com/video out!");
		const result = detectUrl({ ctx });

		expect(result._tag).toBe("Continue");
		if (result._tag === "Continue") {
			expect(result.value.url).toBe("https://example.com/video");
			expect(result.value.ctx).toBe(ctx);
		}
	});

	test("returns Stop when no URL found", () => {
		const ctx = mockCtx("Just some text without links");
		const result = detectUrl({ ctx });

		expect(result._tag).toBe("Stop");
	});

	test("returns Stop for empty text", () => {
		const ctx = mockCtx("");
		const result = detectUrl({ ctx });

		expect(result._tag).toBe("Stop");
	});
});

describe("matchExtractor", () => {
	test("returns Continue with extractor for Instagram URL", () => {
		const ctx = mockCtx("");
		const result = matchExtractor({
			ctx,
			url: "https://instagram.com/p/ABC123",
		});

		expect(result._tag).toBe("Continue");
		if (result._tag === "Continue") {
			expect(result.value.extractor.platform).toBe("instagram");
			expect(result.value.url).toBe("https://instagram.com/p/ABC123");
		}
	});

	test("returns Continue with extractor for YouTube Shorts URL", () => {
		const ctx = mockCtx("");
		const result = matchExtractor({
			ctx,
			url: "https://youtube.com/shorts/ABC123",
		});

		expect(result._tag).toBe("Continue");
		if (result._tag === "Continue") {
			expect(result.value.extractor.platform).toBe("youtube");
		}
	});

	test("returns Continue with extractor for TikTok URL", () => {
		const ctx = mockCtx("");
		const result = matchExtractor({ ctx, url: "https://vm.tiktok.com/ABC123" });

		expect(result._tag).toBe("Continue");
		if (result._tag === "Continue") {
			expect(result.value.extractor.platform).toBe("tiktok");
		}
	});

	test("returns Stop for unsupported URL", () => {
		const ctx = mockCtx("");
		const result = matchExtractor({
			ctx,
			url: "https://facebook.com/user/posts/123",
		});

		expect(result._tag).toBe("Stop");
	});
});

describe("checkFileSize", () => {
	test("returns Continue when size is under limit", () => {
		const ctx = mockCtx("");
		const media = {
			type: "video" as const,
			data: new Blob(["x".repeat(1000)]),
		};
		const result = checkFileSize({ ctx, url: "https://example.com", media });

		expect(result._tag).toBe("Continue");
		if (result._tag === "Continue") {
			expect(result.value.media).toBe(media);
		}
	});

	test("returns Fail when size exceeds 50MB limit", () => {
		const ctx = mockCtx("");
		const media = {
			type: "video" as const,
			data: { size: 60 * 1024 * 1024 } as Blob,
		};
		const result = checkFileSize({ ctx, url: "https://example.com", media });

		expect(result._tag).toBe("Fail");
		if (result._tag === "Fail") {
			expect(result.error).toBe("FILE_TOO_LARGE");
		}
	});

	test("returns Continue when exactly at limit", () => {
		const ctx = mockCtx("");
		const media = {
			type: "video" as const,
			data: { size: 50 * 1024 * 1024 } as Blob,
		};
		const result = checkFileSize({ ctx, url: "https://example.com", media });

		expect(result._tag).toBe("Continue");
	});

	test("returns Continue when just under limit", () => {
		const ctx = mockCtx("");
		const media = {
			type: "video" as const,
			data: { size: 50 * 1024 * 1024 - 1 } as Blob,
		};
		const result = checkFileSize({ ctx, url: "https://example.com", media });

		expect(result._tag).toBe("Continue");
	});

	test("returns Continue for photo under limit", () => {
		const ctx = mockCtx("");
		const media = {
			type: "photo" as const,
			data: new Blob(["x".repeat(1000)]),
		};
		const result = checkFileSize({ ctx, url: "https://example.com", media });

		expect(result._tag).toBe("Continue");
	});

	test("returns Continue for URL string data (zero size)", () => {
		const ctx = mockCtx("");
		const media = { type: "video" as const, data: "https://cdn/foo.mp4" };
		const result = checkFileSize({ ctx, url: "https://example.com", media });

		expect(result._tag).toBe("Continue");
	});

	test("returns Continue for carousel under limit", () => {
		const ctx = mockCtx("");
		const media = {
			type: "carousel" as const,
			items: [
				{ type: "photo" as const, data: new Blob(["x".repeat(1000)]) },
				{ type: "photo" as const, data: new Blob(["y".repeat(2000)]) },
			],
		};
		const result = checkFileSize({ ctx, url: "https://example.com", media });

		expect(result._tag).toBe("Continue");
	});

	test("returns Fail when any carousel item exceeds limit", () => {
		const ctx = mockCtx("");
		const media = {
			type: "carousel" as const,
			items: [
				{ type: "photo" as const, data: new Blob(["x"]) },
				{
					type: "photo" as const,
					data: { size: 60 * 1024 * 1024 } as Blob,
				},
			],
		};
		const result = checkFileSize({ ctx, url: "https://example.com", media });

		expect(result._tag).toBe("Fail");
		if (result._tag === "Fail") {
			expect(result.error).toBe("FILE_TOO_LARGE");
		}
	});

	test("returns Fail when carousel audio exceeds limit", () => {
		const ctx = mockCtx("");
		const media = {
			type: "carousel" as const,
			items: [{ type: "photo" as const, data: new Blob(["x"]) }],
			audio: { data: { size: 60 * 1024 * 1024 } as Blob },
		};
		const result = checkFileSize({ ctx, url: "https://example.com", media });

		expect(result._tag).toBe("Fail");
		if (result._tag === "Fail") {
			expect(result.error).toBe("FILE_TOO_LARGE");
		}
	});

	test("returns Continue for carousel with URL string items", () => {
		const ctx = mockCtx("");
		const media = {
			type: "carousel" as const,
			items: [
				{ type: "photo" as const, data: "https://cdn/1.jpg" },
				{ type: "photo" as const, data: "https://cdn/2.jpg" },
			],
		};
		const result = checkFileSize({ ctx, url: "https://example.com", media });

		expect(result._tag).toBe("Continue");
	});
});

describe("sendMedia", () => {
	const makeCtx = () => {
		const calls: { method: string; args: unknown[] }[] = [];
		const ctx = {
			sendChatAction: async (...args: unknown[]) => {
				calls.push({ method: "sendChatAction", args });
			},
			sendVideo: async (...args: unknown[]) => {
				calls.push({ method: "sendVideo", args });
				return { video: { fileId: "vid-1" } };
			},
			sendPhoto: async (...args: unknown[]) => {
				calls.push({ method: "sendPhoto", args });
				return { photo: [{ fileId: "ph-1" }, { fileId: "ph-2" }] };
			},
			sendAudio: async (...args: unknown[]) => {
				calls.push({ method: "sendAudio", args });
				return { audio: { fileId: "au-1" } };
			},
			sendMediaGroup: async (...args: unknown[]) => {
				calls.push({ method: "sendMediaGroup", args });
			},
			reply: async (...args: unknown[]) => {
				calls.push({ method: "reply", args });
			},
		} as unknown as MessageContext;
		return { ctx, calls };
	};

	test("dispatches to sendVideo for video media", async () => {
		const { sendMedia } = await import("bot/transforms");
		const { ctx, calls } = makeCtx();
		const media = {
			type: "video" as const,
			data: new Blob(["x"]),
			width: 1080,
			height: 1920,
			duration: 30,
		};

		const result = await sendMedia({ ctx, url: "https://example.com", media });

		expect(result._tag).toBe("Continue");
		expect(calls.some((c) => c.method === "sendVideo")).toBe(true);
		expect(calls.some((c) => c.method === "sendPhoto")).toBe(false);
	});

	test("dispatches to sendPhoto for photo media", async () => {
		const { sendMedia } = await import("bot/transforms");
		const { ctx, calls } = makeCtx();
		const media = {
			type: "photo" as const,
			data: new Blob(["x"]),
		};

		const result = await sendMedia({ ctx, url: "https://example.com", media });

		expect(result._tag).toBe("Continue");
		expect(calls.some((c) => c.method === "sendPhoto")).toBe(true);
		expect(calls.some((c) => c.method === "sendVideo")).toBe(false);
	});

	test("dispatches to sendMediaGroup for carousel with correct item shape", async () => {
		const { sendMedia } = await import("bot/transforms");
		const { ctx, calls } = makeCtx();
		const blob = new Blob(["x"]);
		const media = {
			type: "carousel" as const,
			items: [
				{ type: "photo" as const, data: "https://cdn/1.jpg" },
				{ type: "video" as const, data: blob },
			],
		};

		const result = await sendMedia({ ctx, url: "https://example.com", media });

		expect(result._tag).toBe("Continue");
		const groupCall = calls.find((c) => c.method === "sendMediaGroup");
		expect(groupCall).toBeDefined();
		const items = groupCall?.args[0] as { type: string; media: unknown }[];
		expect(items).toEqual([
			{ type: "photo", media: "https://cdn/1.jpg" },
			{ type: "video", media: blob },
		]);
		expect(calls.some((c) => c.method === "sendAudio")).toBe(false);
	});

	test("sends a one-item carousel directly, then sends its audio", async () => {
		const { sendMedia } = await import("bot/transforms");
		const { ctx, calls } = makeCtx();
		const media = {
			type: "carousel" as const,
			items: [{ type: "photo" as const, data: "https://cdn/1.jpg" }],
			audio: {
				data: new Blob(["a"]),
				duration: 30,
				title: "Track",
				performer: "Artist",
			},
		};

		await sendMedia({ ctx, url: "https://example.com", media });

		const audioIdx = calls.findIndex((c) => c.method === "sendAudio");
		const photoIdx = calls.findIndex((c) => c.method === "sendPhoto");
		expect(photoIdx).toBeGreaterThan(-1);
		expect(audioIdx).toBeGreaterThan(photoIdx);
		expect(calls.some((c) => c.method === "sendMediaGroup")).toBe(false);

		const audioArgs = calls[audioIdx]?.args ?? [];
		const params = audioArgs[1] as {
			title?: string;
			performer?: string;
			duration?: number;
		};
		expect(params.title).toBe("Track");
		expect(params.performer).toBe("Artist");
		expect(params.duration).toBe(30);
	});

	test("chunks carousels at Telegram's ten-item media-group limit", async () => {
		const { sendMedia } = await import("bot/transforms");
		const { ctx, calls } = makeCtx();
		const media = {
			type: "carousel" as const,
			items: Array.from({ length: 11 }, (_, index) => ({
				type: "photo" as const,
				data: `https://cdn/${index}.jpg`,
			})),
		};

		await sendMedia({ ctx, url: "https://example.com", media });

		const groups = calls.filter((c) => c.method === "sendMediaGroup");
		expect(groups).toHaveLength(1);
		expect(groups[0]?.args[0]).toHaveLength(10);
		expect(calls.filter((c) => c.method === "sendPhoto")).toHaveLength(1);
	});

	test("wraps audio Blob into named File for sendAudio", async () => {
		const { sendMedia } = await import("bot/transforms");
		const { ctx, calls } = makeCtx();
		const media = {
			type: "audio" as const,
			data: new Blob(["a"]),
			title: "Hello",
			performer: "World",
		};

		await sendMedia({ ctx, url: "https://example.com", media });

		const call = calls.find((c) => c.method === "sendAudio");
		const file = call?.args[0] as File;
		expect(file).toBeInstanceOf(File);
		expect(file.name).toBe("World - Hello.mp3");
	});

	test("passes URL string for audio through without wrapping", async () => {
		const { sendMedia } = await import("bot/transforms");
		const { ctx, calls } = makeCtx();
		const media = {
			type: "audio" as const,
			data: "https://cdn/audio.mp3",
		};

		await sendMedia({ ctx, url: "https://example.com", media });

		const call = calls.find((c) => c.method === "sendAudio");
		expect(call?.args[0]).toBe("https://cdn/audio.mp3");
	});

	test("dispatches only to sendAudio for top-level audio", async () => {
		const { sendMedia } = await import("bot/transforms");
		const { ctx, calls } = makeCtx();
		const media = {
			type: "audio" as const,
			data: new Blob(["a"]),
		};

		await sendMedia({ ctx, url: "https://example.com", media });

		expect(calls.some((c) => c.method === "sendAudio")).toBe(true);
		expect(calls.some((c) => c.method === "sendVideo")).toBe(false);
		expect(calls.some((c) => c.method === "sendPhoto")).toBe(false);
		expect(calls.some((c) => c.method === "sendMediaGroup")).toBe(false);
	});

	test("audio filename falls back to 'audio.mp3' when no title/performer", async () => {
		const { sendMedia } = await import("bot/transforms");
		const { ctx, calls } = makeCtx();
		const media = {
			type: "audio" as const,
			data: new Blob(["a"]),
		};

		await sendMedia({ ctx, url: "https://example.com", media });

		const file = calls.find((c) => c.method === "sendAudio")?.args[0] as File;
		expect(file.name).toBe("audio.mp3");
	});

	test("audio filename uses title only when performer missing", async () => {
		const { sendMedia } = await import("bot/transforms");
		const { ctx, calls } = makeCtx();
		const media = {
			type: "audio" as const,
			data: new Blob(["a"]),
			title: "Track",
		};

		await sendMedia({ ctx, url: "https://example.com", media });

		const file = calls.find((c) => c.method === "sendAudio")?.args[0] as File;
		expect(file.name).toBe("Track.mp3");
	});

	test("audio filename uses performer only when title missing", async () => {
		const { sendMedia } = await import("bot/transforms");
		const { ctx, calls } = makeCtx();
		const media = {
			type: "audio" as const,
			data: new Blob(["a"]),
			performer: "Artist",
		};

		await sendMedia({ ctx, url: "https://example.com", media });

		const file = calls.find((c) => c.method === "sendAudio")?.args[0] as File;
		expect(file.name).toBe("Artist.mp3");
	});

	test("audio extension picks from blob mime type", async () => {
		const { sendMedia } = await import("bot/transforms");
		const { ctx, calls } = makeCtx();
		const media = {
			type: "audio" as const,
			data: new Blob(["a"], { type: "audio/mp4" }),
			title: "Track",
		};

		await sendMedia({ ctx, url: "https://example.com", media });

		const file = calls.find((c) => c.method === "sendAudio")?.args[0] as File;
		expect(file.name).toBe("Track.m4a");
	});

	test("counts HTML entities by visible caption length", async () => {
		const { sendMedia } = await import("bot/transforms");
		const { ctx, calls } = makeCtx();
		const media = {
			type: "video" as const,
			data: new Blob(["x"]),
			caption: { text: "&".repeat(1_000) },
		};

		await sendMedia({ ctx, url: "https://example.com/entity-caption", media });

		const videoCall = calls.find((call) => call.method === "sendVideo");
		const params = videoCall?.args[1] as { caption?: string };
		expect(params.caption).toBe("&amp;".repeat(1_000));
		expect(calls.some((call) => call.method === "reply")).toBe(false);
	});

	test("escapes each overflow chunk without splitting a surrogate pair", async () => {
		const { sendMedia } = await import("bot/transforms");
		const { ctx, calls } = makeCtx();
		const media = {
			type: "text" as const,
			caption: { text: `${"a".repeat(4_095)}😀&tail` },
		};

		await sendMedia({ ctx, url: "https://example.com/overflow", media });

		const replies = calls.filter((call) => call.method === "reply");
		expect(replies).toHaveLength(2);
		expect(replies[0]?.args[0]).toBe("a".repeat(4_095));
		expect(replies[1]?.args[0]).toBe("😀&amp;tail");
	});

	test("coalesces concurrent cold video sends and replays the file_id", async () => {
		const { sendMedia } = await import("bot/transforms");
		const inputs: (Blob | string)[] = [];
		let releaseUpload: (() => void) | undefined;
		const uploadGate = new Promise<void>((resolve) => {
			releaseUpload = resolve;
		});
		const makeVideoCtx = (id: number) =>
			({
				id,
				sendChatAction: async () => undefined,
				sendVideo: async (input: Blob | string) => {
					inputs.push(input);
					if (input instanceof Blob) await uploadGate;
					return { video: { fileId: "shared-video-id" } };
				},
			}) as unknown as MessageContext;
		const media = {
			type: "video" as const,
			data: new Blob(["cold-video"]),
		};
		const url = "https://example.com/concurrent-video";

		const first = sendMedia({ ctx: makeVideoCtx(1), url, media });
		while (inputs.length === 0) await Bun.sleep(1);
		const second = sendMedia({ ctx: makeVideoCtx(2), url, media });
		await Bun.sleep(5);

		expect(inputs).toHaveLength(1);
		releaseUpload?.();
		await Promise.all([first, second]);

		expect(inputs.filter((input) => input instanceof Blob)).toHaveLength(1);
		expect(inputs.filter((input) => input === "shared-video-id")).toHaveLength(
			1,
		);
	});

	test("does not propagate the leader chat error to another chat", async () => {
		const { sendMedia } = await import("bot/transforms");
		let releaseLeader: (() => void) | undefined;
		const leaderGate = new Promise<void>((resolve) => {
			releaseLeader = resolve;
		});
		let leaderStarted = false;
		let followerUploads = 0;

		const leader = {
			id: 101,
			sendChatAction: async () => undefined,
			sendVideo: async () => {
				leaderStarted = true;
				await leaderGate;
				throw new Error("Forbidden: bot was blocked by the user");
			},
		} as unknown as MessageContext;
		const follower = {
			id: 102,
			sendChatAction: async () => undefined,
			sendVideo: async () => {
				followerUploads++;
				return { video: { fileId: "follower-file-id" } };
			},
		} as unknown as MessageContext;
		const media = { type: "video" as const, data: new Blob(["shared"]) };
		const url = "https://example.com/chat-isolation-video";

		const first = sendMedia({ ctx: leader, url, media });
		while (!leaderStarted) await Bun.sleep(1);
		const second = sendMedia({ ctx: follower, url, media });
		await Bun.sleep(5);
		releaseLeader?.();

		const [firstResult, secondResult] = await Promise.allSettled([
			first,
			second,
		]);
		expect(firstResult.status).toBe("rejected");
		expect(secondResult.status).toBe("fulfilled");
		expect(followerUploads).toBe(1);
	});
});

describe("checkFileSize audio variant", () => {
	test("returns Fail when top-level audio Blob exceeds limit", () => {
		const ctx = mockCtx("");
		const media = {
			type: "audio" as const,
			data: { size: 60 * 1024 * 1024 } as Blob,
		};
		const result = checkFileSize({ ctx, url: "https://example.com", media });

		expect(result._tag).toBe("Fail");
		if (result._tag === "Fail") {
			expect(result.error).toBe("FILE_TOO_LARGE");
		}
	});

	test("returns Continue when audio is URL string", () => {
		const ctx = mockCtx("");
		const media = {
			type: "audio" as const,
			data: "https://cdn/audio.mp3",
		};
		const result = checkFileSize({ ctx, url: "https://example.com", media });

		expect(result._tag).toBe("Continue");
	});

	test("returns Fail when a remote video declares an oversized payload", () => {
		const ctx = mockCtx("");
		const media = {
			type: "video" as const,
			data: {
				kind: "remote" as const,
				url: "https://cdn/video.mp4",
				size: 60 * 1024 * 1024,
			},
		};
		const result = checkFileSize({ ctx, url: "https://example.com", media });

		expect(result._tag).toBe("Fail");
	});
});
