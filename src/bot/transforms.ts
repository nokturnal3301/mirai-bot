import type { Caption, Extractor, Media, Platform } from "extractors/types";
import { config, env } from "config";
import {
	getCachedMedia,
	createSingleFlight,
	deleteCachedMedia,
	isResponseTooLargeFailure,
	logger,
	findUrls,
	createRateLimiter,
	normalizeUrl,
	recordFailure,
	takeDownloadSlot,
	withStickyProxy,
	type CachedMedia,
	type ExtractionError,
} from "lib";
import { type Flow, F, chain } from "lib/flow";
import { findExtractor } from "extractors/registry";
import { type ErrorCode, ERRORS } from "bot/constants";
import type {
	Ctx,
	MessageContext,
	WithLinks,
	WithExtractor,
	WithMedia,
} from "bot/types";
import { renderErrorCard, sendRichMessage } from "bot/rich-message";
import {
	bestEffortTelegram,
	isChatUnreachable,
	isInvalidFileId,
	isRemoteMediaResource,
	isTelegramFile,
	messageOf,
	sendTelegramMedia,
} from "bot/telegram";

const rateLimiter = createRateLimiter(config.rateLimit);
const extractSingle = createSingleFlight<Flow<Media, ExtractionError>>();
const requestStartedAt = new WeakMap<MessageContext, number>();
const PROXY_ATTEMPTS = 2;
// A shorter wait for a download slot is not worth a log line.
const QUEUE_LOG_THRESHOLD_MS = 250;

type SupportedLink = { url: string; extractor: Extractor };

const elapsedMs = (startedAt: number): string =>
	`${(performance.now() - startedAt).toFixed(0)}ms`;

// Visible links first, then links hidden behind text. A forwarded photo or
// video carries its links in the caption.
const linksOf = (ctx: MessageContext): string[] => [
	...findUrls(ctx.text ?? ctx.caption ?? ""),
	...(ctx.entities ?? ctx.captionEntities ?? []).flatMap(({ type, url }) =>
		type === "text_link" && url ? [url] : [],
	),
];

const supportedLink = (links: readonly string[]): SupportedLink | undefined =>
	links
		.map((url) => ({ url, extractor: findExtractor(url) }))
		.find((link): link is SupportedLink => link.extractor !== undefined);

const noteFailure = (url: string, code: string, message: string): void =>
	void recordFailure({
		platform: findExtractor(url)?.platform ?? "unknown",
		url: normalizeUrl(url),
		code,
		message,
	});

export const logMessage = ({ ctx }: Ctx): Flow<Ctx> => {
	requestStartedAt.set(ctx, performance.now());
	logger.info(
		`[message] update=${ctx.updateId ?? "?"} message=${ctx.id} chat=${ctx.chat.type} text=${(ctx.text ?? ctx.caption)?.length ?? 0}chars`,
	);

	return F.of({ ctx });
};

export const detectLinks = ({ ctx }: Ctx): Flow<WithLinks> => {
	const links = linksOf(ctx);
	return links.length > 0 ? F.of({ ctx, links }) : F.stop();
};

// The first link a platform extractor accepts wins; the rest are ignored.
export const matchExtractor = ({
	ctx,
	links,
}: WithLinks): Flow<WithExtractor> => {
	const link = supportedLink(links);
	if (!link) return F.stop();

	logger.info(
		`[${link.extractor.platform}] processing ${normalizeUrl(link.url)}`,
	);
	return F.of({ ctx, ...link });
};

export const checkRateLimit = ({
	ctx,
	url,
	extractor,
}: WithExtractor): Flow<WithExtractor> => {
	if (!ctx.from) return F.stop();

	if (!rateLimiter.check(ctx.from.id)) {
		logger.warn(`[rate-limit] @${ctx.from.username ?? ctx.from.id}`);
		return F.fail("RATE_LIMITED" satisfies ErrorCode);
	}

	return F.of({ ctx, url, extractor });
};

const extractFresh = async ({
	ctx,
	url,
	extractor,
}: WithExtractor): Promise<Flow<WithMedia>> => {
	const result = await extractSingle(normalizeUrl(url), async () => {
		const queuedMs = await takeDownloadSlot();
		if (queuedMs > QUEUE_LOG_THRESHOLD_MS) {
			logger.info(
				`[queue] waited ${queuedMs.toFixed(0)}ms for a download slot`,
			);
		}

		const startedAt = performance.now();
		let extracted = await extractor.extract(url);
		let route = "direct";

		if (
			extracted._tag === "Fail" &&
			extracted.error.retryable &&
			env.PROXY_URL
		) {
			route = "proxy";
			const requestedCountry =
				typeof extracted.error.details?.proxyCountry === "string"
					? extracted.error.details.proxyCountry
					: undefined;
			for (let attempt = 1; attempt <= PROXY_ATTEMPTS; attempt++) {
				logger.info(
					`[${extractor.platform}] retrying via proxy ${attempt}/${PROXY_ATTEMPTS}${requestedCountry ? ` (${requestedCountry})` : ""}: ${extracted.error.code} ${extracted.error.message}`,
				);
				extracted = await withStickyProxy(
					() => extractor.extract(url),
					requestedCountry ? { country: requestedCountry } : undefined,
				);
				if (extracted._tag !== "Fail" || !extracted.error.retryable) break;
			}
		}

		logger.info(
			`[${extractor.platform}] extraction ${extracted._tag.toLowerCase()} via ${route} in ${elapsedMs(startedAt)}`,
		);
		return extracted;
	});

	if (result._tag === "Continue") {
		const media = withSource(result.value, extractor.platform);
		return F.of({ ctx, url, media });
	}

	if (result._tag === "Stop") return F.stop();
	noteFailure(url, result.error.code, result.error.message);
	if (result.error.code === "MEDIA_TOO_LARGE") return F.fail("FILE_TOO_LARGE");
	if (result.error.code === "AGE_RESTRICTED") return F.fail("AGE_RESTRICTED");

	logger.warn(
		`[${extractor.platform}] extraction failed: ${result.error.code} ${result.error.message}`,
	);
	return F.fail("EXTRACTION_FAILED" satisfies ErrorCode);
};

export const extract = async (
	state: WithExtractor,
): Promise<Flow<WithMedia>> => {
	const { ctx, url, extractor } = state;
	const startedAt = performance.now();
	const cached = await getCachedMedia(url);
	if (!cached) return extractFresh(state);

	logger.info(`[cache] hit ${normalizeUrl(url)} in ${elapsedMs(startedAt)}`);
	const media = withSource(mediaFromCache(cached), extractor.platform);
	return F.of({ ctx, url, media });
};

const withSource = (media: Media, source: Platform): Media => {
	if (media.type === "audio") return media;
	if (media.type === "text") {
		return { ...media, caption: { ...media.caption, source } };
	}
	const caption: Caption = { ...(media.caption ?? {}), source };
	return { ...media, caption };
};

const mediaFromCache = (cached: CachedMedia): Media => {
	const { fileId, width, height, duration, title, performer, caption } = cached;
	const data = { kind: "telegram" as const, fileId };
	switch (cached.type) {
		case "photo":
			return { type: "photo", data, width, height, caption };
		case "audio":
			return { type: "audio", data, duration, title, performer };
		default:
			return { type: "video", data, width, height, duration, caption };
	}
};

const byteSizeOf = (data: unknown): number | undefined => {
	if (data instanceof Blob) return data.size;
	if (isRemoteMediaResource(data)) return data.size;
	if (
		typeof data === "object" &&
		data !== null &&
		"size" in data &&
		typeof data.size === "number"
	) {
		return data.size;
	}
	return undefined;
};

const byteSizesOf = (media: Media): number[] => {
	if (media.type === "text") return [];
	const items =
		media.type === "carousel"
			? [...media.items.map((i) => i.data), media.audio?.data]
			: [media.data];
	return items.flatMap((data) => {
		const size = byteSizeOf(data);
		return size === undefined ? [] : [size];
	});
};

export const checkFileSize = ({
	ctx,
	url,
	media,
}: WithMedia): Flow<WithMedia> => {
	const overBytes = byteSizesOf(media).find(
		(bytes) => bytes > config.telegram.maxFileSize,
	);
	if (overBytes !== undefined) {
		const size = `${(overBytes / 1024 / 1024).toFixed(1)}MB`;
		logger.warn(`file too large: ${size}`);
		noteFailure(url, "FILE_TOO_LARGE", size);
		return F.fail("FILE_TOO_LARGE" satisfies ErrorCode);
	}
	return F.of({ ctx, url, media });
};

const isStaleCachedFile = (media: Media, error: unknown): boolean =>
	"data" in media && isTelegramFile(media.data) && isInvalidFileId(error);

// Telegram no longer has the cached file: forget it and download the post again.
const resend = async ({
	ctx,
	url,
}: Ctx<{ url: string }>): Promise<Flow<Ctx>> => {
	logger.warn(`[cache] stale file for ${normalizeUrl(url)}, downloading again`);
	await deleteCachedMedia(url);
	const extractor = findExtractor(url);
	if (!extractor) return F.fail("UNKNOWN" satisfies ErrorCode);

	return chain(extractFresh({ ctx, url, extractor }))
		.pipe(checkFileSize)
		.pipe(sendMedia)
		.run();
};

export const sendMedia = async ({
	ctx,
	url,
	media,
}: WithMedia): Promise<Flow<Ctx>> => {
	const startedAt = performance.now();
	const requestStart = requestStartedAt.get(ctx) ?? startedAt;
	try {
		await sendTelegramMedia(ctx, url, media);
	} catch (error) {
		if (isStaleCachedFile(media, error)) return resend({ ctx, url });

		const message = messageOf(error);
		logger.error(
			`[send] ${media.type} failed in ${elapsedMs(startedAt)}: ${message}`,
		);
		logger.error(
			`[request] message=${ctx.id} failed in ${elapsedMs(requestStart)}`,
		);
		if (isResponseTooLargeFailure(error)) {
			noteFailure(url, "FILE_TOO_LARGE", message);
			return F.fail("FILE_TOO_LARGE" satisfies ErrorCode);
		}
		noteFailure(url, "SEND_FAILED", message);
		return isChatUnreachable(error)
			? F.stop()
			: F.fail("UNKNOWN" satisfies ErrorCode);
	}
	logger.info(`[send] ${media.type} complete in ${elapsedMs(startedAt)}`);
	logger.info(
		`[request] message=${ctx.id} complete in ${elapsedMs(requestStart)}`,
	);
	return F.of({ ctx });
};

// The card is the last thing a failed request can do, so a card that fails to
// send is only logged.
export const replyError =
	(ctx: MessageContext) =>
	async (error: string): Promise<Flow<Ctx>> => {
		const code = Object.hasOwn(ERRORS, error)
			? (error as ErrorCode)
			: "UNKNOWN";
		const link = supportedLink(linksOf(ctx));
		await bestEffortTelegram("error card", () =>
			sendRichMessage(
				ctx,
				renderErrorCard(code, link?.extractor.platform, link?.url),
				[],
				{ reply_parameters: { message_id: ctx.id } },
			),
		);
		return F.stop();
	};
