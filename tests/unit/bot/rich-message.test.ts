import { describe, expect, spyOn, test } from "bun:test";
import { SOURCE_ICONS } from "bot/constants";
import {
	descriptionChunks,
	renderCard,
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
	test("signs media with a quiet footer above closed details without buttons", () => {
		const html = renderCard(
			{
				source: "instagram",
				author: "@creator",
				text: "Claude. This is Codex.\n\n#claude #ai",
			},
			[{ type: "video", media: "file-id" }],
		);
		expect(html).toContain('<video src="tg://video?id=media-0"></video>');
		expect(html).toContain(
			`<footer><tg-emoji emoji-id="${SOURCE_ICONS.instagram}">✴️</tg-emoji> @creator</footer>`,
		);
		expect(html).toContain(
			"<details><summary>Description</summary><p>Claude. This is Codex.<br><br>#claude #ai</p></details>",
		);
		expect(html).not.toContain("<details open");
		expect(html.indexOf("<video")).toBeLessThan(html.indexOf("<footer>"));
		expect(html.indexOf("<footer>")).toBeLessThan(html.indexOf("<details>"));
		expect(html).not.toContain("<tg-button");
	});

	test("adds duration and quality for a single video", () => {
		const signed = (duration: number) =>
			renderCard({ source: "tiktok", author: "creator" }, [
				{
					type: "video",
					media: "file-id",
					width: 720,
					height: 1280,
					duration,
				},
			]);
		expect(signed(19)).toContain("</tg-emoji> @creator · 0:19 · 720p</footer>");
		expect(signed(3725)).toContain("@creator · 1:02:05 · 720p</footer>");
		expect(
			renderCard({ author: "creator" }, [
				{ type: "photo", media: "file-id", width: 1080, height: 1350 },
			]),
		).toContain("<footer>@creator</footer>");
	});

	test("escapes untrusted text and omits empty details", () => {
		const html = renderCard({
			author: '<script>&"',
			text: '</details><video src="https://evil.example"/>',
		});
		expect(html).not.toContain("<script>");
		expect(html).not.toContain('<video src="https://evil.example"');
		expect(html).toContain(
			"&lt;/details&gt;&lt;video src=&quot;https://evil.example&quot;/&gt;",
		);
		expect(renderCard({ source: "youtube", text: "  " })).not.toContain(
			"<details",
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
			expect(renderCard(undefined, [], chunk)).toContain("<details>");
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
