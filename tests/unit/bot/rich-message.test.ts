import { describe, expect, spyOn, test } from "bun:test";
import { SOURCE_ICONS } from "bot/constants";
import {
	descriptionChunks,
	renderCard,
	richFileId,
	sendRichMessage,
} from "bot/rich-message";
import type { MessageContext } from "bot/types";

const ctx = {
	chatId: 123,
	threadId: 42,
	isTopicMessage: () => true,
	businessConnectionId: "business-1",
} as unknown as MessageContext;

describe("rich messages", () => {
	test("keeps media, author, platform and original outside closed details", () => {
		const html = renderCard(
			"https://instagram.com/p/example?a=1&b=2",
			{
				source: "instagram",
				author: "@creator",
				text: "Claude. This is Codex.\n\n#claude #ai",
			},
			[{ type: "video", media: "file-id" }],
		);
		expect(html).toContain('<video src="tg://video?id=media-0"></video>');
		expect(html).toContain("<b>@creator</b> · <tg-emoji");
		expect(html).toContain(`emoji-id="${SOURCE_ICONS.instagram}"`);
		expect(html).toContain(
			"<details><summary>Description</summary><p>Claude. This is Codex.<br><br>#claude #ai</p></details>",
		);
		expect(html).not.toContain("<details open");
		expect(html.indexOf("<video")).toBeLessThan(html.indexOf("<details>"));
		expect(html.indexOf("@creator")).toBeLessThan(html.indexOf("<details>"));
		expect(html.indexOf("</details>")).toBeLessThan(
			html.indexOf("<tg-button-row>"),
		);
		expect(html).toContain(
			'url="https://instagram.com/p/example?a=1&amp;b=2">Original ↗',
		);
	});

	test("escapes untrusted text and attribute values and omits empty details", () => {
		const html = renderCard('https://example.com/?q="<x>', {
			author: '<script>&"',
			text: '</details><video src="https://evil.example"/>',
		});
		expect(html).not.toContain("<script>");
		expect(html).not.toContain('<video src="https://evil.example"');
		expect(html).toContain(
			"&lt;/details&gt;&lt;video src=&quot;https://evil.example&quot;/&gt;",
		);
		expect(html).toContain('url="https://example.com/?q=&quot;&lt;x&gt;"');
		expect(
			renderCard("https://example.com", { source: "youtube", text: "  " }),
		).not.toContain("<details");
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
			expect(renderCard("https://example.com", undefined, [], chunk)).toContain(
				"<details>",
			);
		}
	});

	test("uploads nested mixed media and preserves topic and business routing", async () => {
		const video = new Blob(["video bytes"], { type: "video/mp4" });
		const photo = new Blob(["photo bytes"], { type: "image/jpeg" });
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				ok: true,
				result: {
					rich_message: {
						blocks: [{ type: "video", video: { file_id: "uploaded" } }],
					},
				},
			}),
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
				renderCard("https://example.com", undefined, media),
				media,
			);
			const [url, init] = fetchSpy.mock.calls[0] ?? [];
			expect(String(url)).toEndWith("/sendRichMessage");
			const form = init?.body as FormData;
			expect(form).toBeInstanceOf(FormData);
			expect(form.get("chat_id")).toBe("123");
			expect(form.get("message_thread_id")).toBe("42");
			expect(form.get("business_connection_id")).toBe("business-1");
			expect(await (form.get("media-0") as File).text()).toBe("video bytes");
			expect(await (form.get("media-1") as File).text()).toBe("photo bytes");
			const rich = JSON.parse(String(form.get("rich_message")));
			expect(rich.html).toContain("<tg-slideshow>");
			expect(rich.media).toEqual([
				{
					id: "media-0",
					media: {
						type: "video",
						media: "attach://media-0",
						supports_streaming: true,
						duration: 12,
					},
				},
				{ id: "media-1", media: { type: "photo", media: "attach://media-1" } },
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
			Response.json({
				ok: true,
				result: {
					rich_message: {
						blocks: [
							{
								type: "photo",
								photo: [{ file_id: "small" }, { file_id: "large" }],
							},
						],
					},
				},
			}),
		);
		try {
			const media = [{ type: "photo" as const, media: "cached-photo" }];
			const message = await sendRichMessage(
				{ chatId: 321 } as MessageContext,
				renderCard("https://example.com", undefined, media),
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
					renderCard("https://example.com", {
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
			const html = renderCard("https://example.com", { source: "instagram" });
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
