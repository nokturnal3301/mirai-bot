import { describe, test, expect } from "bun:test";

import { F, chain } from "lib/flow";
import { detectUrl, matchExtractor } from "bot/transforms";
import type { MessageContext } from "bot/types";

const mockCtx = (text: string) =>
	({
		text,
		chat: { id: 123, type: "private", title: "Test" },
		from: { id: 456, username: "testuser" },
	}) as unknown as MessageContext;

describe("extraction pipeline", () => {
	test("finds URL and matches Instagram extractor", async () => {
		const ctx = mockCtx("Check this https://instagram.com/reel/ABC123 out!");

		const result = await chain(F.of({ ctx }))
			.pipe(detectUrl)
			.pipe(matchExtractor)
			.run();

		expect(result._tag).toBe("Continue");
		if (result._tag === "Continue") {
			expect(result.value.extractor.platform).toBe("instagram");
			expect(result.value.url).toBe("https://instagram.com/reel/ABC123");
		}
	});

	test("finds URL and matches YouTube Shorts extractor", async () => {
		const ctx = mockCtx("Watch https://youtube.com/shorts/dQw4w9WgXcQ");

		const result = await chain(F.of({ ctx }))
			.pipe(detectUrl)
			.pipe(matchExtractor)
			.run();

		expect(result._tag).toBe("Continue");
		if (result._tag === "Continue") {
			expect(result.value.extractor.platform).toBe("youtube");
		}
	});

	test("finds URL and matches TikTok extractor", async () => {
		const ctx = mockCtx("Check https://vm.tiktok.com/ABC123");

		const result = await chain(F.of({ ctx }))
			.pipe(detectUrl)
			.pipe(matchExtractor)
			.run();

		expect(result._tag).toBe("Continue");
		if (result._tag === "Continue") {
			expect(result.value.extractor.platform).toBe("tiktok");
		}
	});

	test("returns Stop for unsupported URL", async () => {
		const ctx = mockCtx("Visit https://facebook.com/user/posts/123");

		const result = await chain(F.of({ ctx }))
			.pipe(detectUrl)
			.pipe(matchExtractor)
			.run();

		expect(result._tag).toBe("Stop");
	});

	test("returns Stop for text without URL", async () => {
		const ctx = mockCtx("No links here, just plain text");

		const result = await chain(F.of({ ctx }))
			.pipe(detectUrl)
			.pipe(matchExtractor)
			.run();

		expect(result._tag).toBe("Stop");
	});
});
