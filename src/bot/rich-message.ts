import { SOURCE_ICONS } from "bot/constants";
import type { MessageContext } from "bot/types";
import { env } from "config";
import type { Caption } from "extractors/types";

// GramIO 0.4 doesn't yet serialize sendRichMessage's nested media uploads.
export type RichMedia = {
	type: "video" | "photo";
	media: Blob | string;
	width?: number;
	height?: number;
	duration?: number;
	supports_streaming?: boolean;
};

type RichMessageResult = {
	rich_message?: {
		blocks: {
			type: string;
			video?: { file_id: string };
			photo?: { file_id: string }[];
		}[];
	};
};

export const escapeHtml = (value: string): string =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

// Leave room for author, platform and summary within 32768 characters.
const DESCRIPTION_CHUNK = 30_000;

export const descriptionChunks = (caption?: Caption): string[] => {
	const characters = Array.from(caption?.text?.trim() ?? "");
	const chunks: string[] = [];
	for (let i = 0; i < characters.length; i += DESCRIPTION_CHUNK) {
		chunks.push(characters.slice(i, i + DESCRIPTION_CHUNK).join(""));
	}
	return chunks;
};

const formatDuration = (seconds: number): string => {
	const total = Math.round(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const rest = String(total % 60).padStart(2, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
		: `${minutes}:${rest}`;
};

const videoFacts = (media: RichMedia[]): string[] => {
	const [video] = media;
	if (media.length !== 1 || video?.type !== "video") return [];
	return [
		video.duration ? formatDuration(video.duration) : "",
		video.width && video.height
			? `${Math.min(video.width, video.height)}p`
			: "",
	].filter(Boolean);
};

export const renderCard = (
	caption?: Caption,
	media: RichMedia[] = [],
	description = descriptionChunks(caption)[0],
): string => {
	const elements = media.map((item, index) =>
		item.type === "photo"
			? `<img src="tg://photo?id=media-${index}"/>`
			: `<video src="tg://video?id=media-${index}"></video>`,
	);
	const gallery =
		elements.length > 1
			? `<tg-collage>${elements.join("")}</tg-collage>`
			: (elements[0] ?? "");
	const author = caption?.author?.replace(/^@/, "");
	const signature = [
		author ? `@${escapeHtml(Array.from(author).slice(0, 256).join(""))}` : "",
		...videoFacts(media),
	]
		.filter(Boolean)
		.join(" · ");
	const icon = caption?.source ? SOURCE_ICONS[caption.source] : undefined;
	const footer = [
		icon ? `<tg-emoji emoji-id="${icon}">✴️</tg-emoji>` : "",
		signature,
	]
		.filter(Boolean)
		.join(" ");
	const details = description
		? `<details><summary>Description</summary><p>${escapeHtml(description).replace(/\r?\n/g, "<br>")}</p></details>`
		: "";
	return [gallery, footer ? `<footer>${footer}</footer>` : "", details]
		.filter(Boolean)
		.join("\n");
};

export const sendRichMessage = async (
	ctx: MessageContext,
	html: string,
	media: RichMedia[] = [],
): Promise<RichMessageResult> => {
	const form = new FormData();
	const attachments = media.map((item, index) => {
		const id = `media-${index}`;
		if (typeof item.media === "string") return { id, media: item };
		const filename = item.type === "video" ? "video.mp4" : "photo.jpg";
		form.append(id, item.media, filename);
		return { id, media: { ...item, media: `attach://${id}` } };
	});
	const destination = {
		chat_id: ctx.chatId,
		...(ctx.threadId && ctx.isTopicMessage()
			? { message_thread_id: ctx.threadId }
			: {}),
		...(ctx.businessConnectionId
			? { business_connection_id: ctx.businessConnectionId }
			: {}),
	};
	const params = {
		...destination,
		rich_message: { html, media: attachments },
	};
	const multipart = media.some((item) => item.media instanceof Blob);
	if (multipart) {
		for (const [key, value] of Object.entries(params)) {
			form.set(
				key,
				typeof value === "object" ? JSON.stringify(value) : String(value),
			);
		}
	}
	const response = await fetch(
		`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendRichMessage`,
		{
			method: "POST",
			...(!multipart
				? { headers: { "Content-Type": "application/json" } }
				: {}),
			body: multipart ? form : JSON.stringify(params),
			signal: AbortSignal.timeout(120_000),
		},
	);
	const result = (await response.json()) as
		| { ok: true; result: RichMessageResult }
		| { ok: false; description: string };
	if (!result.ok) throw new Error(result.description);
	return result.result;
};

export const richFileId = (
	message: RichMessageResult,
	type: "video" | "photo",
): string | undefined => {
	const block = message.rich_message?.blocks.find((item) => item.type === type);
	return type === "video"
		? block?.video?.file_id
		: block?.photo?.at(-1)?.file_id;
};

export const sendDescriptionOverflow = async (
	ctx: MessageContext,
	caption?: Caption,
): Promise<void> => {
	for (const chunk of descriptionChunks(caption).slice(1)) {
		await sendRichMessage(ctx, renderCard(caption, [], chunk));
	}
};
