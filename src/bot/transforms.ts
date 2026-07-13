import type { Caption, Media, Platform } from "extractors/types";
import { config, env } from "config";
import {
	getCachedMedia,
	createSingleFlight,
	isResponseTooLargeFailure,
	logger,
	findUrl,
	createRateLimiter,
	normalizeUrl,
	withHttpContext,
	type CachedMedia,
	type ExtractionError,
} from "lib";
import { type Flow, F } from "lib/flow";
import { findExtractor } from "extractors/registry";
import { type ErrorCode, ERRORS } from "bot/constants";
import type {
	Ctx,
	MessageContext,
	WithUrl,
	WithExtractor,
	WithMedia,
} from "bot/types";
import { isRemoteMediaResource, sendTelegramMedia } from "bot/telegram";

const rateLimiter = createRateLimiter(config.rateLimit);
const extractSingle = createSingleFlight<Flow<Media, ExtractionError>>();
const requestStartedAt = new WeakMap<MessageContext, number>();

const elapsedMs = (startedAt: number): string =>
	`${(performance.now() - startedAt).toFixed(0)}ms`;

export const logMessage = ({ ctx }: Ctx): Flow<Ctx> => {
	requestStartedAt.set(ctx, performance.now());
	logger.info(
		`[message] update=${ctx.updateId ?? "?"} message=${ctx.id} chat=${ctx.chat.type} text=${ctx.text?.length ?? 0}chars`,
	);

	return F.of({ ctx });
};

export const detectUrl = ({ ctx }: Ctx): Flow<WithUrl> => {
	const url = findUrl(ctx.text ?? "");
	return url ? F.of({ ctx, url }) : F.stop();
};

export const matchExtractor = ({ ctx, url }: WithUrl): Flow<WithExtractor> => {
	const extractor = findExtractor(url);
	if (!extractor) return F.stop();

	logger.info(`[${extractor.platform}] processing ${normalizeUrl(url)}`);
	return F.of({ ctx, url, extractor });
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

export const extract = async ({
	ctx,
	url,
	extractor,
}: WithExtractor): Promise<Flow<WithMedia>> => {
	const startedAt = performance.now();
	const cached = await getCachedMedia(url);

	if (cached) {
		logger.info(`[cache] hit ${normalizeUrl(url)} in ${elapsedMs(startedAt)}`);
		const media = mediaFromCache(cached);
		return F.of({ ctx, url, media });
	}

	const result = await extractSingle(normalizeUrl(url), async () => {
		let extracted = await extractor.extract(url);
		let route = "direct";

		if (
			extracted._tag === "Fail" &&
			extracted.error.retryable &&
			env.PROXY_URL
		) {
			logger.info(
				`[${extractor.platform}] retrying via proxy: ${extracted.error.code} ${extracted.error.message}`,
			);
			route = "proxy";
			extracted = await withHttpContext({ forceProxy: true }, () =>
				extractor.extract(url),
			);
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
	if (result.error.code === "MEDIA_TOO_LARGE") return F.fail("FILE_TOO_LARGE");

	logger.warn(
		`[${extractor.platform}] extraction failed: ${result.error.code} ${result.error.message}`,
	);
	return F.fail("EXTRACTION_FAILED" satisfies ErrorCode);
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
	const { fileId: data, width, height, duration, title, performer } = cached;
	const caption = cached.caption as Caption | undefined;
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
		logger.warn(`file too large: ${(overBytes / 1024 / 1024).toFixed(1)}MB`);
		return F.fail("FILE_TOO_LARGE" satisfies ErrorCode);
	}
	return F.of({ ctx, url, media });
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
		const message = error instanceof Error ? error.message : String(error);
		logger.error(
			`[send] ${media.type} failed in ${elapsedMs(startedAt)}: ${message}`,
		);
		logger.error(
			`[request] message=${ctx.id} failed in ${elapsedMs(requestStart)}`,
		);
		if (isResponseTooLargeFailure(error)) {
			return F.fail("FILE_TOO_LARGE" satisfies ErrorCode);
		}
		throw error;
	}
	logger.info(`[send] ${media.type} complete in ${elapsedMs(startedAt)}`);
	logger.info(
		`[request] message=${ctx.id} complete in ${elapsedMs(requestStart)}`,
	);
	return F.of({ ctx });
};

export const replyError =
	(ctx: MessageContext) =>
	async (error: string): Promise<Flow<Ctx>> => {
		const message = ERRORS[error as ErrorCode] ?? ERRORS.UNKNOWN;
		await ctx.reply(message);
		return F.stop();
	};
