import { describe, expect, test } from "bun:test";
import { deliverMedia } from "bot/telegram";
import { getHttpContext } from "lib";

describe("telegram delivery", () => {
	test("sends an upload Blob as multipart", async () => {
		const blob = new Blob(["video"]);
		const seen: unknown[] = [];

		const result = await deliverMedia(blob, async (input) => {
			seen.push(input);
			return "sent";
		});

		expect(seen).toEqual([blob]);
		expect(result).toEqual({
			value: "sent",
			route: "multipart",
			bytes: blob.size,
		});
	});

	test("passes a Telegram file_id through without downloading", async () => {
		const result = await deliverMedia("cached-file-id", async (input) => input);

		expect(result).toEqual({
			value: "cached-file-id",
			route: "file-id",
		});
	});

	test("lets Telegram fetch a remote resource directly", async () => {
		let downloads = 0;
		const result = await deliverMedia(
			{
				kind: "remote",
				url: "https://cdn.test/video.mp4",
				headers: { Referer: "https://tiktok.com/" },
				size: 1024,
			},
			async (input) => input,
			async () => {
				downloads += 1;
				return new Blob(["fallback"]);
			},
		);

		expect(downloads).toBe(0);
		expect(result).toEqual({
			value: "https://cdn.test/video.mp4",
			route: "remote-url",
			bytes: 1024,
		});
	});

	test("falls back to multipart when Telegram rejects a remote URL", async () => {
		const fallback = new Blob(["fallback"]);
		const seen: unknown[] = [];
		const result = await deliverMedia(
			{
				kind: "remote",
				url: "https://cdn.test/video.mp4",
				headers: { Cookie: "session=value" },
			},
			async (input) => {
				seen.push(input);
				if (typeof input === "string") {
					throw new Error("failed to get HTTP URL content");
				}
				return "uploaded";
			},
			async (_url, options) => {
				expect(options?.headers).toEqual({ Cookie: "session=value" });
				return fallback;
			},
		);

		expect(seen).toEqual(["https://cdn.test/video.mp4", fallback]);
		expect(result).toEqual({
			value: "uploaded",
			route: "multipart",
			bytes: fallback.size,
		});
	});

	test("skips Telegram URL fetch for a header-bound resource", async () => {
		const fallback = new Blob(["fallback"]);
		const seen: unknown[] = [];
		const result = await deliverMedia(
			{
				kind: "remote",
				url: "https://cdn.test/video.mp4",
				telegramFetch: false,
			},
			async (input) => {
				seen.push(input);
				return "uploaded";
			},
			async () => fallback,
		);

		expect(seen).toEqual([fallback]);
		expect(result.route).toBe("multipart");
	});

	test("downloads a route-bound resource in its captured HTTP context", async () => {
		const context = { forceProxy: true, proxySession: "youtube-session" };
		let seenContext: ReturnType<typeof getHttpContext>;
		let seenHeaders: HeadersInit | undefined;
		let seenConnections: number | undefined;

		const result = await deliverMedia(
			{
				kind: "remote",
				url: "https://cdn.test/video.mp4",
				headers: { "User-Agent": "youtube-client" },
				telegramFetch: false,
				connections: 6,
				httpContext: context,
			},
			async () => "uploaded",
			async (_url, options) => {
				seenContext = getHttpContext();
				seenHeaders = options?.headers;
				seenConnections = options?.connections;
				return new Blob(["video"]);
			},
		);

		expect(seenContext).toEqual(context);
		expect(seenHeaders).toEqual({ "User-Agent": "youtube-client" });
		expect(seenConnections).toBe(6);
		expect(result.route).toBe("multipart");
	});

	test("does not download when Telegram rejects the chat", async () => {
		let downloads = 0;
		const task = deliverMedia(
			{ kind: "remote", url: "https://cdn.test/video.mp4" },
			async () => {
				throw new Error("Forbidden: bot was blocked by the user");
			},
			async () => {
				downloads += 1;
				return new Blob();
			},
		);

		await expect(task).rejects.toThrow("blocked by the user");
		expect(downloads).toBe(0);
	});

	test("does not retry an ambiguous Telegram timeout as multipart", async () => {
		let downloads = 0;
		const task = deliverMedia(
			{ kind: "remote", url: "https://cdn.test/video.mp4" },
			async () => {
				throw new Error("network timeout after request");
			},
			async () => {
				downloads += 1;
				return new Blob();
			},
		);

		await expect(task).rejects.toThrow("network timeout");
		expect(downloads).toBe(0);
	});
});
