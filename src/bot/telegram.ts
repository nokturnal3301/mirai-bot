import type { Media, RemoteMediaResource } from "extractors/types";
import {
	createSingleFlight,
	deleteCachedMedia,
	download,
	getCachedMedia,
	logger,
	normalizeUrl,
	setCachedMedia,
	withHttpContext,
} from "lib";
import { AUDIO_EXT } from "bot/constants";
import type { MessageContext } from "bot/types";
import {
	renderCard,
	richFileId,
	sendDescriptionOverflow,
	sendRichMessage,
} from "bot/rich-message";

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export const bestEffortTelegram = async (
	label: string,
	run: () => Promise<unknown>,
): Promise<void> => {
	try {
		await run();
	} catch (error) {
		logger.warn(`[telegram] ${label} skipped: ${messageOf(error)}`);
	}
};

type TelegramMediaInput = Blob | string;
export type DeliveryRoute = "file-id" | "remote-url" | "multipart";

type DeliveryResult<T> = {
	value: T;
	route: DeliveryRoute;
	bytes?: number;
};

export const isRemoteMediaResource = (
	value: unknown,
): value is RemoteMediaResource =>
	typeof value === "object" &&
	value !== null &&
	"kind" in value &&
	value.kind === "remote";

const elapsedMs = (startedAt: number): string =>
	`${(performance.now() - startedAt).toFixed(0)}ms`;

const sizeLabel = (bytes: number | undefined): string =>
	bytes === undefined ? "?MB" : `${(bytes / 1024 / 1024).toFixed(2)}MB`;

const isRemoteFetchRejection = (error: unknown): boolean =>
	/(?:failed to get http url content|wrong file identifier\/http url specified|wrong type of the web page content|failed to get .* content)/i.test(
		messageOf(error),
	);

const isInvalidFileId = (error: unknown): boolean =>
	/(?:wrong file identifier|file reference .*expired|invalid file[_ ]?id)/i.test(
		messageOf(error),
	);

export const deliverMedia = async <T>(
	resource: Blob | string | RemoteMediaResource,
	send: (input: TelegramMediaInput) => Promise<T>,
	fetchRemote: typeof download = download,
): Promise<DeliveryResult<T>> => {
	if (resource instanceof Blob) {
		return {
			value: await send(resource),
			route: "multipart",
			bytes: resource.size,
		};
	}

	if (typeof resource === "string") {
		return {
			value: await send(resource),
			route: /^https?:\/\//i.test(resource) ? "remote-url" : "file-id",
		};
	}

	if (resource.telegramFetch !== false) {
		const remoteStartedAt = performance.now();
		try {
			const value = await send(resource.url);
			logger.info(
				`[delivery] Telegram fetched ${sizeLabel(resource.size)} in ${elapsedMs(remoteStartedAt)}`,
			);
			return { value, route: "remote-url", bytes: resource.size };
		} catch (error) {
			if (!isRemoteFetchRejection(error)) throw error;
			logger.warn(
				`[delivery] Telegram URL fetch rejected in ${elapsedMs(remoteStartedAt)}: ${messageOf(error)}`,
			);
		}
	}

	const downloadStartedAt = performance.now();
	const fetch = () =>
		fetchRemote(resource.url, {
			headers: resource.headers,
			...(resource.connections !== undefined
				? { connections: resource.connections }
				: {}),
			label: "telegram-media",
		});
	const blob = resource.httpContext
		? await withHttpContext(resource.httpContext, fetch)
		: await fetch();
	logger.info(
		`[delivery] fallback downloaded ${sizeLabel(blob.size)} in ${elapsedMs(downloadStartedAt)}`,
	);
	return {
		value: await send(blob),
		route: "multipart",
		bytes: blob.size,
	};
};

const toAudioFile = (
	data: Blob | string,
	title?: string,
	performer?: string,
): Blob | string => {
	if (typeof data === "string") return data;
	const filename = [performer, title].filter(Boolean).join(" - ") || "audio";
	const ext = AUDIO_EXT[data.type] ?? "mp3";
	return new File([data], `${filename}.${ext}`);
};

type CoordinatedVideoSend = {
	owner: symbol | null;
	fileId?: string;
	route?: DeliveryRoute;
	bytes?: number;
	error?: unknown;
};

const videoSendSingle = createSingleFlight<CoordinatedVideoSend>();

const sendVideo = async (
	ctx: MessageContext,
	url: string,
	media: Extract<Media, { type: "video" }>,
): Promise<void> => {
	void bestEffortTelegram("video chat action", () =>
		ctx.sendChatAction("upload_video"),
	);
	const expectedBytes =
		media.data instanceof Blob
			? media.data.size
			: isRemoteMediaResource(media.data)
				? media.data.size
				: undefined;

	logger.info(
		`[send] video ${media.width ?? "?"}x${media.height ?? "?"} ${media.duration ?? "?"}s ${sizeLabel(expectedBytes)}`,
	);

	const params = {
		type: "video" as const,
		supports_streaming: true,
		width: media.width,
		height: media.height,
		duration: media.duration,
	};
	const send = (input: Blob | string) => {
		const attachments = [{ ...params, media: input }];
		return sendRichMessage(
			ctx,
			renderCard(media.caption, attachments),
			attachments,
		);
	};
	const isFileId =
		typeof media.data === "string" && !/^https?:\/\//i.test(media.data);
	let route: DeliveryRoute;
	let bytes = expectedBytes;

	if (isFileId) {
		try {
			const delivered = await deliverMedia(media.data, send);
			route = delivered.route;
		} catch (error) {
			if (isInvalidFileId(error)) await deleteCachedMedia(url);
			throw error;
		}
	} else {
		const owner = Symbol("video-send");
		const coordinated = await videoSendSingle(normalizeUrl(url), async () => {
			try {
				const cached = await getCachedMedia(url);
				if (cached && (cached.type === undefined || cached.type === "video")) {
					return {
						owner: null,
						fileId: cached.fileId,
						route: "file-id" as const,
					};
				}

				const delivered = await deliverMedia(media.data, send);
				const fileId = richFileId(delivered.value, "video");
				if (fileId) {
					await setCachedMedia(url, {
						fileId,
						type: "video",
						width: media.width,
						height: media.height,
						duration: media.duration,
						caption: media.caption,
					});
				}

				return {
					owner,
					fileId,
					route: delivered.route,
					bytes: delivered.bytes,
				};
			} catch (error) {
				return { owner, error };
			}
		});

		if (coordinated.owner === owner) {
			if (coordinated.error) throw coordinated.error;
			route = coordinated.route ?? "multipart";
			bytes = coordinated.bytes;
		} else if (coordinated.fileId) {
			await deliverMedia(coordinated.fileId, send);
			route = "file-id";
			logger.info("[delivery] joined in-flight video send via file_id");
		} else {
			const delivered = await deliverMedia(media.data, send);
			route = delivered.route;
			bytes = delivered.bytes;
		}
	}

	logger.info(`[send] video delivered via ${route} ${sizeLabel(bytes)}`);
	await sendDescriptionOverflow(ctx, media.caption);
};

const sendPhoto = async (
	ctx: MessageContext,
	url: string,
	media: Extract<Media, { type: "photo" }>,
): Promise<void> => {
	void bestEffortTelegram("photo chat action", () =>
		ctx.sendChatAction("upload_photo"),
	);
	logger.info(`[send] photo ${media.width ?? "?"}x${media.height ?? "?"}`);

	const attachments = [{ type: "photo" as const, media: media.data }];
	const message = await sendRichMessage(
		ctx,
		renderCard(media.caption, attachments),
		attachments,
	);
	const fileId = richFileId(message, "photo");
	if (fileId) {
		await setCachedMedia(url, {
			fileId,
			type: "photo",
			width: media.width,
			height: media.height,
			caption: media.caption,
		});
	}

	await sendDescriptionOverflow(ctx, media.caption);
};

const sendAudio = async (
	ctx: MessageContext,
	url: string,
	media: Extract<Media, { type: "audio" }>,
): Promise<void> => {
	void bestEffortTelegram("audio chat action", () =>
		ctx.sendChatAction("upload_voice"),
	);

	logger.info(
		`[send] audio "${media.title ?? "?"}" by ${media.performer ?? "?"} ${media.duration ?? "?"}s`,
	);

	const message = await ctx.sendAudio(
		toAudioFile(media.data, media.title, media.performer),
		{
			duration: media.duration,
			title: media.title,
			performer: media.performer,
		},
	);

	const fileId = message.audio?.fileId;
	if (fileId) {
		await setCachedMedia(url, {
			fileId,
			type: "audio",
			duration: media.duration,
			title: media.title,
			performer: media.performer,
		});
	}
};

const sendText = async (
	ctx: MessageContext,
	media: Extract<Media, { type: "text" }>,
): Promise<void> => {
	logger.info(`[send] text @${media.caption.author ?? "?"}`);
	await sendRichMessage(ctx, renderCard(media.caption));
	await sendDescriptionOverflow(ctx, media.caption);
};

const RICH_MEDIA_LIMIT = 50;

const sendCarousel = async (
	ctx: MessageContext,
	media: Extract<Media, { type: "carousel" }>,
): Promise<void> => {
	void bestEffortTelegram("carousel chat action", () =>
		ctx.sendChatAction("upload_photo"),
	);
	logger.info(`[send] carousel ${media.items.length} items`);
	if (media.items.length === 0) throw new Error("empty carousel");

	for (
		let offset = 0;
		offset < media.items.length;
		offset += RICH_MEDIA_LIMIT
	) {
		const attachments = media.items
			.slice(offset, offset + RICH_MEDIA_LIMIT)
			.map((item) => ({
				type: item.type,
				media: item.data,
				...(item.type === "video"
					? {
							width: item.width,
							height: item.height,
							duration: item.duration,
							supports_streaming: true,
						}
					: {}),
			}));
		await sendRichMessage(
			ctx,
			renderCard(offset === 0 ? media.caption : undefined, attachments),
			attachments,
		);
	}

	if (media.audio) {
		const { data, duration, title, performer } = media.audio;
		await ctx.sendAudio(toAudioFile(data, title, performer), {
			duration,
			title,
			performer,
		});
	}

	await sendDescriptionOverflow(ctx, media.caption);
};

export const sendTelegramMedia = async (
	ctx: MessageContext,
	url: string,
	media: Media,
): Promise<void> => {
	switch (media.type) {
		case "video":
			return sendVideo(ctx, url, media);
		case "photo":
			return sendPhoto(ctx, url, media);
		case "audio":
			return sendAudio(ctx, url, media);
		case "carousel":
			return sendCarousel(ctx, media);
		case "text":
			return sendText(ctx, media);
		default:
			media satisfies never;
	}
};
