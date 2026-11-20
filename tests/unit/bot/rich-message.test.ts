import { describe, expect, spyOn, test } from "bun:test";
import { CARD_ICONS, ERRORS, SOURCE_ICONS } from "bot/constants";
import {
	descriptionChunks,
	renderCard,
	renderErrorCard,
	richFileId,
	sendRichMessage,
} from "bot/rich-message";
import type { MessageContext } from "bot/types";
import { Bot, MessageContext as GramioMessageContext } from "gramio";

const bot = new Bot("test");
const contextOf = (payload: object): MessageContext =>
	new GramioMessageContext({
		bot,
		update_id: 1,
		payload: { message_id: 1, date: 0, ...payload },
	} as never) as unknown as MessageContext;

const ctx = contextOf({
	chat: { id: 123, type: "supergroup", is_forum: true },
	message_thread_id: 42,
	is_topic_message: true,
	business_connection_id: "business-1",
});

const sent = (result: object) => ({
	ok: true,
	result: {
		message_id: 2,
		date: 0,
		chat: { id: 123, type: "private" },
		...result,
	},
});

describe("rich messages", () => {
	test("puts the caption in an expandable quote above a linked footer", () => {
		const html = renderCard(
			{
				source: "instagram",
				author: "@creator",
				text: "Claude. This is Codex.\n\n#claude #ai",
				link: "https://www.instagram.com/p/abc/",
			},
			[{ type: "video", media: "file-id" }],
		);
		expect(html).toContain('<video src="tg://video?id=media-0"></video>');
		expect(html).toContain(
			'<blockquote expandable>Claude. This is Codex.<br><br><a href="https://www.instagram.com/explore/tags/claude/">#claude</a> <a href="https://www.instagram.com/explore/tags/ai/">#ai</a></blockquote>',
		);
		expect(html).toContain(
			`<footer><tg-emoji emoji-id="${SOURCE_ICONS.instagram}"></tg-emoji> <a href="https://www.instagram.com/p/abc/">@creator</a></footer>`,
		);
		expect(html.indexOf("<video")).toBeLessThan(html.indexOf("<blockquote"));
		expect(html.indexOf("<blockquote")).toBeLessThan(html.indexOf("<footer>"));
		expect(html).not.toContain("<details");
		expect(html).not.toContain("<tg-button");
	});

	test("shows the author, quality, stats, date and track in the footer", () => {
		const html = renderCard(
			{
				source: "tiktok",
				author: "creator",
				name: "Creator",
				verified: true,
				stats: { views: 1_234_567, likes: 48_300, comments: 611 },
				postedAt: 1_794_267_069,
				music: "original sound — Creator",
			},
			[
				{
					type: "video",
					media: "file-id",
					width: 720,
					height: 1280,
					duration: 19,
				},
			],
		);
		const icon = (name: keyof typeof CARD_ICONS) =>
			`<tg-emoji emoji-id="${CARD_ICONS[name]}"></tg-emoji>`;
		expect(html).toContain(
			`</tg-emoji> <b>Creator</b> ✓ @creator · 720p<br>${icon("views")} 1.2M · ${icon("likes")} 48.3K · ${icon("comments")} 611 · <tg-time unix="1794267069" format="D">`,
		);
		expect(html).toContain(
			`</tg-time><br>${icon("music")} original sound — Creator</footer>`,
		);
		expect(html).not.toContain("0:19");
		expect(
			renderCard({ author: "creator" }, [
				{ type: "photo", media: "file-id", width: 1080, height: 1350 },
			]),
		).toContain("<footer>@creator</footer>");
		expect(
			renderCard({ source: "youtube", name: "Linus Tech Tips" }),
		).toContain("</tg-emoji> Linus Tech Tips</footer>");
	});

	test("puts Reddit titles above the media and scores in the footer", () => {
		const html = renderCard(
			{
				source: "reddit",
				author: "skvot_mag",
				community: "gaming",
				title: "Big & bold",
				flair: "OC",
				text: "ask @someone about #tag",
				stats: { score: 8423, comments: 612 },
			},
			[{ type: "photo", media: "file-id" }],
		);
		expect(html).toStartWith(
			"<p><b>Big &amp; bold</b> <mark>OC</mark></p>\n<img",
		);
		expect(html).toContain(
			"<blockquote expandable>ask @someone about #tag</blockquote>",
		);
		expect(html).toContain("</tg-emoji> r/gaming · u/skvot_mag<br>");
		expect(html).toContain(
			`<tg-emoji emoji-id="${CARD_ICONS.score}"></tg-emoji> 8.4K`,
		);
	});

	test("links replies, quotes and mentions to the platform", () => {
		const html = renderCard({
			source: "twitter",
			replyTo: "coin",
			text: "via @friend https://ex.com/a?b=1&c=2. mail me@ex.com",
			quote: { author: "@numis", text: "rare" },
		});
		expect(html).toContain(
			`<p><tg-emoji emoji-id="${CARD_ICONS.reply}"></tg-emoji> Replying to <a href="https://x.com/coin">@coin</a></p>`,
		);
		expect(html).toContain(
			'via <a href="https://x.com/friend">@friend</a> <a href="https://ex.com/a?b=1&amp;c=2">https://ex.com/a?b=1&amp;c=2</a>. mail me@ex.com',
		);
		expect(html).toContain(
			'<blockquote>rare<cite><a href="https://x.com/numis">@numis</a></cite></blockquote>',
		);
	});

	test("blurs sensitive media", () => {
		const html = renderCard({ sensitive: true }, [
			{ type: "photo", media: "a" },
			{ type: "video", media: "b" },
		]);
		expect(html).toBe(
			'<tg-collage><img src="tg://photo?id=media-0" tg-spoiler/><video src="tg://video?id=media-1" tg-spoiler></video></tg-collage>',
		);
	});

	test("splits large carousels into even collages of at most ten", () => {
		const collageSizes = (count: number) =>
			renderCard(
				undefined,
				Array.from({ length: count }, () => ({
					type: "photo" as const,
					media: "file-id",
				})),
			)
				.split("</tg-collage>")
				.slice(0, -1)
				.map((collage) => collage.split("<img").length - 1);
		expect(collageSizes(10)).toEqual([10]);
		expect(collageSizes(11)).toEqual([6, 5]);
		expect(collageSizes(19)).toEqual([10, 9]);
		expect(collageSizes(21)).toEqual([7, 7, 7]);
	});

	test("renders error cards with an icon, the reason and a link back to the post", () => {
		expect(
			renderErrorCard(
				"AGE_RESTRICTED",
				"tiktok",
				"https://www.tiktok.com/@a/video/1?x=1&y=2",
			),
		).toBe(
			`<p><tg-emoji emoji-id="${ERRORS.AGE_RESTRICTED.icon}"></tg-emoji> <b>Age-restricted post</b></p>\n<blockquote>Only signed-in users can see it, so I can't download it.</blockquote>\n<footer><tg-emoji emoji-id="${SOURCE_ICONS.tiktok}"></tg-emoji> <a href="https://www.tiktok.com/@a/video/1?x=1&amp;y=2">Open in TikTok</a></footer>`,
		);
		expect(
			renderErrorCard("RATE_LIMITED", "tiktok", "https://www.tiktok.com/@a"),
		).not.toContain("<footer>");
		expect(renderErrorCard("EXTRACTION_FAILED")).not.toContain("<footer>");
	});

	test("escapes untrusted text and omits an empty quote", () => {
		const html = renderCard({
			author: '<script>&"',
			text: '</details><video src="https://evil.example"/>',
		});
		expect(html).not.toContain("<script>");
		expect(html).not.toContain('<video src="https://evil.example"');
		expect(html).toContain(
			'&lt;/details&gt;&lt;video src=&quot;<a href="https://evil.example">https://evil.example</a>&quot;/&gt;',
		);
		expect(renderCard({ source: "youtube", text: "  " })).not.toContain(
			"<blockquote",
		);
	});

	test("chunks long Unicode descriptions without losing text or exceeding rich limits", () => {
		const text = `${"😀&<".repeat(20_000)}tail`;
		const chunks = descriptionChunks({ text });
		expect(chunks.join("")).toBe(text);
		expect(chunks.every((chunk) => Array.from(chunk).length <= 30_000)).toBe(
			true,
		);
		for (const chunk of chunks) {
			expect(chunk.isWellFormed()).toBe(true);
			expect(renderCard(undefined, [], chunk)).toContain(
				"<blockquote expandable>",
			);
		}
	});

	test("uploads nested mixed media and preserves topic and business routing", async () => {
		const video = new Blob(["video bytes"], { type: "video/mp4" });
		const photo = new Blob(["photo bytes"], { type: "image/jpeg" });
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json(
				sent({
					rich_message: {
						blocks: [{ type: "video", video: { file_id: "uploaded" } }],
					},
				}),
			),
		);
		try {
			const media = [
				{
					type: "video" as const,
					media: video,
					supports_streaming: true,
					duration: 12,
				},
				{ type: "photo" as const, media: photo },
				{ type: "photo" as const, media: "existing-photo" },
			];
			const message = await sendRichMessage(
				ctx,
				renderCard(undefined, media),
				media,
			);
			const [url, init] = fetchSpy.mock.calls[0] ?? [];
			expect(String(url)).toEndWith("/sendRichMessage");
			const form = init?.body as FormData;
			expect(form).toBeInstanceOf(FormData);
			expect(form.get("chat_id")).toBe("123");
			expect(form.get("message_thread_id")).toBe("42");
			expect(form.get("business_connection_id")).toBe("business-1");
			const upload = form.get("file-0") as File;
			expect(upload.name).toBe("video.mp4");
			expect(upload.type).toBe("video/mp4");
			expect(await upload.text()).toBe("video bytes");
			expect(await (form.get("file-1") as File).text()).toBe("photo bytes");
			const rich = JSON.parse(String(form.get("rich_message")));
			expect(rich.html).toContain("<tg-collage>");
			expect(rich.html).not.toContain("0:12");
			expect(rich.skip_entity_detection).toBe(true);
			expect(rich.media).toEqual([
				{
					id: "media-0",
					media: {
						type: "video",
						media: "attach://file-0",
						supports_streaming: true,
						duration: 12,
					},
				},
				{ id: "media-1", media: { type: "photo", media: "attach://file-1" } },
				{ id: "media-2", media: { type: "photo", media: "existing-photo" } },
			]);
			expect(media[0]?.media).toBe(video);
			expect(richFileId(message, "video")).toBe("uploaded");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("reuses file IDs with JSON and selects the largest returned photo", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json(
				sent({
					rich_message: {
						blocks: [
							{
								type: "photo",
								photo: [{ file_id: "small" }, { file_id: "large" }],
							},
						],
					},
				}),
			),
		);
		try {
			const media = [{ type: "photo" as const, media: "cached-photo" }];
			const message = await sendRichMessage(
				contextOf({ chat: { id: 321, type: "private" } }),
				renderCard(undefined, media),
				media,
			);
			const params = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
			expect(params.chat_id).toBe(321);
			expect(params.message_thread_id).toBeUndefined();
			expect(params.rich_message.media[0].media.media).toBe("cached-photo");
			expect(richFileId(message, "photo")).toBe("large");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("surfaces custom-emoji rejection without retrying or replacing icons", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
			Response.json({
				ok: false,
				error_code: 400,
				description: "Bad Request: CUSTOM_EMOJI_NOT_ALLOWED",
			}),
		);
		try {
			await expect(
				sendRichMessage(
					ctx,
					renderCard({
						source: "instagram",
						text: "#test",
					}),
				),
			).rejects.toThrow("CUSTOM_EMOJI_NOT_ALLOWED");
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("does not retry network failures or unrelated API errors", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValueOnce(
			new Error("connection reset"),
		);
		try {
			const html = renderCard({ source: "instagram" });
			await expect(sendRichMessage(ctx, html)).rejects.toThrow(
				"connection reset",
			);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			fetchSpy.mockResolvedValueOnce(
				Response.json({
					ok: false,
					error_code: 403,
					description: "Forbidden: blocked",
				}),
			);
			await expect(sendRichMessage(ctx, html)).rejects.toThrow(
				"Forbidden: blocked",
			);
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
