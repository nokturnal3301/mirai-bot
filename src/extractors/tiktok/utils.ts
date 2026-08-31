import { createHash } from "node:crypto";
import type { MediaPlan } from "extractors/media";
import type { SSRItem } from "extractors/tiktok/schemas";
import { SSRDataSchema } from "extractors/tiktok/schemas";
import { config } from "config";
import type { StrategyContext } from "lib";
import type { ExtractionError } from "lib";
import type { Flow } from "lib/flow";
import {
	extractionError,
	F,
	getHttpContext,
	http,
	logger,
	strategyFact,
	withCpuAdmission,
} from "lib";
import {
	DOWNLOAD_CONNECTIONS,
	DOWNLOAD_MIN_BYTES_PER_SECOND,
	HEADERS,
	POST_ID_PATTERN,
	POST_URL_PATTERN,
	SHORT_URL_PATTERN,
} from "extractors/tiktok/constants";

export type TikTokStrategyInput = { url: string };

export type TikTokTarget = {
	pageUrl: string;
	postId: string;
};

const SSR_PATTERN =
	/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/;

export const hasTikTokSsrData = (html: string): boolean =>
	SSR_PATTERN.test(html);

export const parseTikTokItem = (
	html: string,
): Flow<SSRItem, ExtractionError> => {
	const raw = html.match(SSR_PATTERN)?.[1];
	if (!raw) {
		return F.fail(extractionError("UPSTREAM_REJECTED", "no TikTok SSR data"));
	}

	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return F.fail(
			extractionError("SCHEMA_MISMATCH", "invalid TikTok SSR JSON"),
		);
	}

	const parsed = SSRDataSchema.safeParse(json);
	if (!parsed.success) {
		return F.fail(
			extractionError("SCHEMA_MISMATCH", "TikTok SSR schema mismatch"),
		);
	}

	const item =
		parsed.data.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo
			?.itemStruct;
	return item
		? F.of(item)
		: F.fail(extractionError("NO_MEDIA", "no TikTok item struct"));
};

export const imageUrlsOf = (item: SSRItem): string[] =>
	(item.imagePost?.images ?? [])
		.map((image) => image.imageURL?.urlList?.[0])
		.filter((url): url is string => !!url);

export const buildTikTokMediaPlan = (
	item: SSRItem,
	cookies: string,
	route: "page" | "challenge",
): Flow<MediaPlan, ExtractionError> => {
	const caption = { author: item.author?.uniqueId, text: item.desc };
	const publicHeaders = {
		...HEADERS,
		Referer: "https://www.tiktok.com/",
	};
	const authenticatedHeaders = { ...publicHeaders, Cookie: cookies };
	const imageUrls = imageUrlsOf(item);

	if (imageUrls.length > 0) {
		const audio = item.music?.playUrl
			? route === "page"
				? {
						source: {
							kind: "remote" as const,
							url: item.music.playUrl,
						},
						duration: item.music.duration,
						title: item.music.title,
						performer: item.music.authorName,
					}
				: {
						source: {
							kind: "download" as const,
							url: item.music.playUrl,
							headers: publicHeaders,
						},
						duration: item.music.duration,
						title: item.music.title,
						performer: item.music.authorName,
					}
			: undefined;

		return F.of({
			type: "carousel",
			items: imageUrls.map((url) => ({
				type: "photo" as const,
				source: {
					kind: "download" as const,
					url,
					headers: route === "page" ? authenticatedHeaders : publicHeaders,
				},
			})),
			audio,
			caption,
			concurrency: 2,
			maxBytes: config.telegram.maxCarouselBytes,
		});
	}

	const source = videoSourceOf(item);
	if (!source && item.isContentClassified) {
		return F.fail(
			extractionError(
				"UPSTREAM_REJECTED",
				"TikTok requires login for classified content",
				{ retryable: false, terminal: true },
			),
		);
	}
	if (!source || source.url.includes("kmoat")) {
		return F.fail(extractionError("NO_MEDIA", "no TikTok video URL"));
	}
	if (source.oversized) {
		return F.fail(extractionError("MEDIA_TOO_LARGE", "FILE_TOO_LARGE"));
	}

	logger.info(
		`[tiktok] rendition ${source.width ?? "?"}x${source.height ?? "?"} ${sizeLabel(source.size)} ${source.bitrate ?? "?"}bps`,
	);

	// Signed CDN URLs (incl. tt_chain_token) are not IP-bound, so the heavy
	// media transfer runs direct from the fast datacenter link even though the
	// page was extracted through the residential proxy. The proxy is kept only
	// as a fallback for the rare CDN edge that rejects the datacenter IP.
	const authenticatedDownload = {
		kind: "download" as const,
		url: source.url,
		headers: authenticatedHeaders,
		connections: DOWNLOAD_CONNECTIONS,
	};
	return F.of({
		type: "video",
		source: {
			kind: "fallback",
			sources: [
				{
					...authenticatedDownload,
					minBytesPerSecond: DOWNLOAD_MIN_BYTES_PER_SECOND,
					httpContext: { forceProxy: false },
				},
				{
					...authenticatedDownload,
					httpContext: getHttpContext() ?? { forceProxy: true },
				},
			],
		},
		width: source.width,
		height: source.height,
		duration: source.duration,
		caption,
	});
};

const sizeLabel = (bytes: number | undefined): string =>
	bytes === undefined ? "?MB" : `${(bytes / 1024 / 1024).toFixed(2)}MB`;

const TIKTOK_TARGET = strategyFact<TikTokTarget>("tiktok.target");

export const resolveTikTokTarget = (
	input: TikTokStrategyInput,
	context: StrategyContext,
): Promise<TikTokTarget> =>
	context.resolve(TIKTOK_TARGET, async (signal) => {
		const { url } = input;
		const directId = url.match(POST_ID_PATTERN)?.[1];
		if (directId && POST_URL_PATTERN.test(url)) {
			return { pageUrl: url, postId: directId };
		}

		if (!SHORT_URL_PATTERN.test(url)) {
			throw extractionError("NOT_APPLICABLE", "unrecognized TikTok URL");
		}

		const response = await http(url, {
			headers: HEADERS,
			redirect: "manual",
			responseType: "raw",
			signal,
		});
		const location = response.headers.get("location");
		if (!location) {
			throw extractionError("UPSTREAM_REJECTED", "no redirect location");
		}

		const pageUrl = new URL(location, url).toString();
		const postId = pageUrl.match(POST_ID_PATTERN)?.[1];
		if (!postId || !POST_URL_PATTERN.test(pageUrl)) {
			throw extractionError(
				"UPSTREAM_REJECTED",
				"redirect does not contain a TikTok post",
			);
		}

		return { pageUrl, postId };
	});

export type TikTokVideoSource = {
	url: string;
	width?: number;
	height?: number;
	duration?: number;
	size?: number;
	bitrate?: number;
	oversized: boolean;
};

const qualityOf = (candidate: {
	width?: number;
	height?: number;
}): number | undefined => {
	if (candidate.width === undefined || candidate.height === undefined) {
		return candidate.width ?? candidate.height;
	}
	return Math.min(candidate.width, candidate.height);
};

const byBitrateDesc = (
	left: { bitrate: number },
	right: { bitrate: number },
): number => right.bitrate - left.bitrate;

const bySizeAsc = (left: { size?: number }, right: { size?: number }): number =>
	(left.size ?? Number.POSITIVE_INFINITY) -
	(right.size ?? Number.POSITIVE_INFINITY);

export const videoSourceOf = (
	item: SSRItem,
	maxBytes = config.telegram.maxFileSize,
): TikTokVideoSource | null => {
	const video = item.video;
	if (!video) return null;

	const variants = (video.bitrateInfo ?? [])
		.map(({ Bitrate, CodecType, PlayAddr }) => ({
			url: PlayAddr?.UrlList?.[0],
			size: PlayAddr?.DataSize,
			bitrate: Bitrate ?? 0,
			codec: CodecType,
			width: PlayAddr?.Width ?? video.width,
			height: PlayAddr?.Height ?? video.height,
		}))
		.filter(
			(candidate): candidate is typeof candidate & { url: string } =>
				!!candidate.url,
		);
	const h264 = variants.filter(({ codec }) => codec?.startsWith("h264"));
	const candidates = h264.length > 0 ? h264 : variants;

	const fitting = candidates
		.filter(({ size }) => size === undefined || size <= maxBytes)
		.sort(byBitrateDesc);
	const withinLatencyBudget = fitting
		.filter(
			(candidate) =>
				candidate.size !== undefined &&
				candidate.size <= config.tiktok.targetFileSize &&
				(qualityOf(candidate) ?? 0) <= config.tiktok.maxQuality,
		)
		.sort(byBitrateDesc);
	const sizedForTelegramFetch = fitting
		.filter(
			(candidate) =>
				candidate.size !== undefined &&
				candidate.size <= config.tiktok.targetFileSize,
		)
		.sort(byBitrateDesc);
	const qualityBound = fitting
		.filter(
			(candidate) =>
				(qualityOf(candidate) ?? Number.POSITIVE_INFINITY) <=
				config.tiktok.maxQuality,
		)
		.sort(bySizeAsc);
	const smallest = [...candidates].sort(bySizeAsc)[0];
	const selected =
		withinLatencyBudget[0] ??
		sizedForTelegramFetch[0] ??
		qualityBound[0] ??
		smallest;

	if (selected) {
		return {
			url: selected.url,
			width: selected.width,
			height: selected.height,
			duration: video.duration,
			size: selected.size,
			bitrate: selected.bitrate,
			oversized: selected.size !== undefined && selected.size > maxBytes,
		};
	}

	return video.playAddr
		? {
				url: video.playAddr,
				width: video.width,
				height: video.height,
				duration: video.duration,
				oversized: false,
			}
		: null;
};

export const videoUrlOf = (item: SSRItem): string | null =>
	videoSourceOf(item)?.url ?? null;

export const solveChallenge = async (
	html: string,
	signal?: AbortSignal,
): Promise<string | null> => {
	const wci = html.match(/id=["']wci["'][^>]*class=["']([^"']*)["']/)?.[1];
	const cs = html.match(/id=["']cs["'][^>]*class=["']([^"']*)["']/)?.[1];
	if (!wci || !cs) return null;

	let data: { v: { a: string; c: string }; d?: string };
	try {
		data = JSON.parse(Buffer.from(cs, "base64").toString()) as typeof data;
	} catch {
		return null;
	}
	const prefix = Buffer.from(data.v.a, "base64");
	const target = Buffer.from(data.v.c, "base64").toString("hex");

	return withCpuAdmission(async () => {
		for (let i = 0; i <= 1_000_000; i++) {
			if (signal?.aborted) return null;
			if (i > 0 && i % 10_000 === 0) await Bun.sleep(0);
			const digest = createHash("sha256")
				.update(prefix)
				.update(String(i))
				.digest("hex");

			if (digest === target) {
				data.d = Buffer.from(String(i)).toString("base64");
				return `${wci}=${Buffer.from(JSON.stringify(data)).toString("base64")}`;
			}
		}

		return null;
	}, signal);
};
