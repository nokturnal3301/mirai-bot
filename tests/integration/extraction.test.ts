import { describe, test, expect } from "bun:test";

import { F, chain } from "lib/flow";
import { detectLinks, matchExtractor } from "bot/transforms";
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
			.pipe(detectLinks)
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
			.pipe(detectLinks)
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
			.pipe(detectLinks)
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
			.pipe(detectLinks)
			.pipe(matchExtractor)
			.run();

		expect(result._tag).toBe("Stop");
	});

	test("skips unsupported links and takes the first supported one", async () => {
		const ctx = mockCtx(
			"From https://example.com/page see https://vm.tiktok.com/ABC123 and https://instagram.com/reel/ABC123",
		);

		const result = await chain(F.of({ ctx }))
			.pipe(detectLinks)
			.pipe(matchExtractor)
			.run();

		expect(result._tag).toBe("Continue");
		if (result._tag === "Continue") {
			expect(result.value.extractor.platform).toBe("tiktok");
			expect(result.value.url).toBe("https://vm.tiktok.com/ABC123");
		}
	});

	test("reads links from a media caption and from behind text", async () => {
		const captioned = {
			caption: "watch https://youtube.com/shorts/dQw4w9WgXcQ",
			chat: { id: 123, type: "private" },
			from: { id: 456 },
		} as unknown as MessageContext;
		const hidden = {
			text: "watch this",
			entities: [
				{ type: "bold" },
				{ type: "text_link", url: "https://www.instagram.com/reel/ABC123/" },
			],
			chat: { id: 123, type: "private" },
			from: { id: 456 },
		} as unknown as MessageContext;

		const [fromCaption, fromEntity] = await Promise.all(
			[captioned, hidden].map((ctx) =>
				chain(F.of({ ctx })).pipe(detectLinks).pipe(matchExtractor).run(),
			),
		);

		expect(fromCaption).toMatchObject({
			_tag: "Continue",
			value: { url: "https://youtube.com/shorts/dQw4w9WgXcQ" },
		});
		expect(fromEntity).toMatchObject({
			_tag: "Continue",
			value: { url: "https://www.instagram.com/reel/ABC123/" },
		});
	});

	test("returns Stop for text without URL", async () => {
		const ctx = mockCtx("No links here, just plain text");

		const result = await chain(F.of({ ctx }))
			.pipe(detectLinks)
			.pipe(matchExtractor)
			.run();

		expect(result._tag).toBe("Stop");
	});
});
