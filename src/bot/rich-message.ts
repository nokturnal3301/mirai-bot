import {
	CARD_ICONS,
	type ErrorCode,
	ERRORS,
	HASHTAG_URLS,
	PLATFORM_NAMES,
	PROFILE_URLS,
	SOURCE_ICONS,
} from "bot/constants";
import type { MessageContext } from "bot/types";
import type { Caption, Platform } from "extractors/types";

export type RichMedia = {
	type: "video" | "photo";
	media: Blob | string;
	width?: number;
	height?: number;
	duration?: number;
	supports_streaming?: boolean;
};

// The link the author label points to: the post the user sent.
export type Card = Caption & { link?: string };

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

// Leave room for the title, quote and footer within 32768 characters.
const DESCRIPTION_CHUNK = 30_000;

export const descriptionChunks = (caption?: Caption): string[] => {
	const characters = Array.from(caption?.text?.trim() ?? "");
	const chunks: string[] = [];
	for (let i = 0; i < characters.length; i += DESCRIPTION_CHUNK) {
		chunks.push(characters.slice(i, i + DESCRIPTION_CHUNK).join(""));
	}
	return chunks;
};

// Mobile apps don't draw collages beyond album size; split evenly instead.
const COLLAGE_SIZE = 10;

const COMPACT = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});

// Fallback text only; clients render <tg-time> in the reader's locale.
const DATE = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

// URLs, then @handles and #tags not glued to a word, e-mail or path.
const TOKENS =
	/https?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'»]|(?<![\w.@/])@([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?)|(?<![\p{L}\p{N}_&/#])#([\p{L}\p{N}_]+)/gu;

const clip = (value: string, max = 256): string =>
	Array.from(value).slice(0, max).join("");

const emoji = (id: string): string => `<tg-emoji emoji-id="${id}"></tg-emoji>`;

const anchor = (href: string, label: string): string =>
	`<a href="${escapeHtml(href)}">${label}</a>`;

const profile = (source: Platform | undefined, handle: string): string => {
	const label = `@${escapeHtml(clip(handle))}`;
	return source
		? anchor(PROFILE_URLS[source](encodeURIComponent(handle)), label)
		: label;
};

const hashtag = (source: Platform | undefined, tag: string): string => {
	const url = source ? HASHTAG_URLS[source] : undefined;
	const label = `#${escapeHtml(tag)}`;
	return url ? anchor(url(encodeURIComponent(tag)), label) : label;
};

// Entity detection is off, so links are built here: mentions and tags lead
// to the platform instead of a Telegram user or search of the same name.
const richText = (text: string, source?: Platform): string => {
	let html = "";
	let last = 0;
	for (const match of text.matchAll(TOKENS)) {
		const [token, handle, tag] = match;
		html += escapeHtml(text.slice(last, match.index));
		html +=
			tag !== undefined
				? hashtag(source, tag)
				: handle === undefined
					? anchor(token, escapeHtml(token))
					: source === "reddit"
						? escapeHtml(token)
						: profile(source, handle);
		last = match.index + token.length;
	}
	return `${html}${escapeHtml(text.slice(last))}`.replace(/\r?\n/g, "<br>");
};

const quality = (media: RichMedia[]): string => {
	const [video] = media;
	if (media.length !== 1 || video?.type !== "video") return "";
	return video.width && video.height
		? `${Math.min(video.width, video.height)}p`
		: "";
};

const identity = (card: Card, media: RichMedia[]): string => {
	const handle = card.author?.replace(/^@/, "");
	const name = card.name?.trim() ? escapeHtml(clip(card.name.trim())) : "";
	const linked = (label: string) =>
		card.link ? anchor(card.link, label) : label;
	const check = card.verified ? "✓" : "";
	const label = handle
		? escapeHtml(clip(card.source === "reddit" ? `u/${handle}` : `@${handle}`))
		: "";
	const people = label
		? name
			? [`<b>${name}</b>`, check, linked(label)]
			: [linked(label), check]
		: name
			? [linked(name), check]
			: [];
	const details = [
		card.community ? `r/${escapeHtml(clip(card.community))}` : "",
		people.filter(Boolean).join(" "),
		quality(media),
	]
		.filter(Boolean)
		.join(" · ");
	const logo = card.source ? emoji(SOURCE_ICONS[card.source]) : "";
	return [logo, details].filter(Boolean).join(" ");
};

const statsLine = (card: Card): string => {
	const { views, likes, score, comments } = card.stats ?? {};
	const stat = (icon: string, value?: number) =>
		value === undefined || !Number.isFinite(value)
			? ""
			: `${emoji(icon)} ${COMPACT.format(value)}`;
	const date =
		card.postedAt && Number.isFinite(card.postedAt)
			? `<tg-time unix="${Math.trunc(card.postedAt)}" format="D">${DATE.format(new Date(card.postedAt * 1000))}</tg-time>`
			: "";
	return [
		stat(CARD_ICONS.views, views),
		stat(CARD_ICONS.likes, likes),
		stat(CARD_ICONS.score, score),
		stat(CARD_ICONS.comments, comments),
		date,
	]
		.filter(Boolean)
		.join(" · ");
};

const footer = (card: Card, media: RichMedia[]): string => {
	const lines = [
		identity(card, media),
		statsLine(card),
		card.music?.trim()
			? `${emoji(CARD_ICONS.music)} ${escapeHtml(clip(card.music.trim()))}`
			: "",
	].filter(Boolean);
	return lines.length ? `<footer>${lines.join("<br>")}</footer>` : "";
};

const gallery = (media: RichMedia[], sensitive?: boolean): string => {
	const spoiler = sensitive ? " tg-spoiler" : "";
	const elements = media.map((item, index) =>
		item.type === "photo"
			? `<img src="tg://photo?id=media-${index}"${spoiler}/>`
			: `<video src="tg://video?id=media-${index}"${spoiler}></video>`,
	);
	if (elements.length < 2) return elements[0] ?? "";
	const collages = Math.ceil(elements.length / COLLAGE_SIZE);
	const perCollage = Math.ceil(elements.length / collages);
	return Array.from(
		{ length: collages },
		(_, i) =>
			`<tg-collage>${elements.slice(i * perCollage, (i + 1) * perCollage).join("")}</tg-collage>`,
	).join("\n");
};

const quoteBlock = (card: Card): string => {
	const text = card.quote?.text.trim();
	if (!text) return "";
	const author = card.quote?.author?.replace(/^@/, "");
	const cite = author ? `<cite>${profile(card.source, author)}</cite>` : "";
	return `<blockquote>${richText(text, card.source)}${cite}</blockquote>`;
};

export const renderCard = (
	card: Card = {},
	media: RichMedia[] = [],
	description = descriptionChunks(card)[0],
): string => {
	const title = card.title?.trim()
		? `<p><b>${escapeHtml(clip(card.title.trim(), 1024))}</b>${card.flair?.trim() ? ` <mark>${escapeHtml(clip(card.flair.trim()))}</mark>` : ""}</p>`
		: "";
	const reply = card.replyTo
		? `<p>${emoji(CARD_ICONS.reply)} Replying to ${profile(card.source, card.replyTo.replace(/^@/, ""))}</p>`
		: "";
	const text = description
		? `<blockquote expandable>${richText(description, card.source)}</blockquote>`
		: "";
	return [
		title,
		gallery(media, card.sensitive),
		reply,
		text,
		quoteBlock(card),
		footer(card, media),
	]
		.filter(Boolean)
		.join("\n");
};

export const renderErrorCard = (
	code: ErrorCode,
	source?: Platform,
	link?: string,
): string => {
	const error = ERRORS[code];
	const back =
		error.link && source && link
			? `<footer>${emoji(SOURCE_ICONS[source])} ${anchor(link, `Open in ${PLATFORM_NAMES[source]}`)}</footer>`
			: "";
	return [
		`<p>${emoji(error.icon)} <b>${error.title}</b></p>`,
		`<blockquote>${error.text}</blockquote>`,
		back,
	]
		.filter(Boolean)
		.join("\n");
};

const FILENAMES = { video: "video.mp4", photo: "photo.jpg" } as const;

// GramIO swaps uploaded Blobs for attach:// links in place, so pass copies.
export const sendRichMessage = async (
	ctx: MessageContext,
	html: string,
	media: RichMedia[] = [],
	params?: Parameters<MessageContext["sendRichMessage"]>[1],
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
	const message = await ctx.sendRichMessage(
		{ html, media: attachments, skip_entity_detection: true },
		params,
	);
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

// Continuation cards carry only the rest of the text.
export const sendDescriptionOverflow = async (
	ctx: MessageContext,
	card?: Card,
): Promise<void> => {
	for (const chunk of descriptionChunks(card).slice(1)) {
		await sendRichMessage(
			ctx,
			`<blockquote expandable>${richText(chunk, card?.source)}</blockquote>`,
		);
	}
};
