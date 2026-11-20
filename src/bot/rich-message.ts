import { SOURCE_ICONS } from "bot/constants";
import type { MessageContext } from "bot/types";
import type { Caption } from "extractors/types";

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

const FILENAMES = { video: "video.mp4", photo: "photo.jpg" } as const;

// GramIO swaps uploaded Blobs for attach:// links in place, so pass copies.
export const sendRichMessage = async (
	ctx: MessageContext,
	html: string,
	media: RichMedia[] = [],
): Promise<RichMessageResult> => {
	const attachments = media.map((item, index) => ({
		id: `media-${index}`,
		media: {
			...item,
			media:
				item.media instanceof Blob
					? new File([item.media], FILENAMES[item.type], {
							type: item.media.type,
						})
					: item.media,
		},
	}));
	const message = await ctx.sendRichMessage({ html, media: attachments });
	return message.payload;
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
