import { config } from "config";
import type {
	AtomicVideoSource,
	MediaItemPlan,
	MediaPlan,
} from "extractors/media";
import type {
	InstagramGraphMedia,
	InstagramMedia,
} from "extractors/instagram/schemas";
import { InstagramGraphMediaSchema, InstagramMediaSchema } from "./schemas";
import {
	CRAWLER_HEADERS,
	DOWNLOAD_CONNECTIONS,
	DOWNLOAD_MIN_BYTES_PER_SECOND,
} from "./constants";
import {
	extractionError,
	F,
	getHttpContext,
	logger,
	type ExtractionError,
	type Flow,
} from "lib";

export const extractShortcode = (url: string): string | null => {
	const match = url.match(
		/instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/,
	);
	return match?.[1] ?? null;
};

const SHORTCODE_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const instagramMediaIdOf = (shortcode: string): string | null => {
	let value = 0n;
	for (const char of shortcode) {
		const digit = SHORTCODE_ALPHABET.indexOf(char);
		if (digit < 0) return null;
		value = value * 64n + BigInt(digit);
	}
	return value.toString();
};

export type DashStreams = {
	videoUrl: string;
	audioUrl: string;
	width?: number;
	height?: number;
	codecCompatible: boolean;
};

export const parseDashManifest = (manifest: string): DashStreams | null => {
	const unescaped = manifest.replace(/&amp;/g, "&");

	const audioMatch = unescaped.match(
		/<AdaptationSet[^>]*contentType="audio"[\s\S]*?<BaseURL>([^<]+)<\/BaseURL>/,
	);
	if (!audioMatch?.[1]) return null;

	const videoSection = unescaped.match(
		/<AdaptationSet[^>]*contentType="video"[\s\S]*?<\/AdaptationSet>/,
	);
	if (!videoSection?.[0]) return null;

	const reps = [
		...videoSection[0].matchAll(
			/<Representation[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"[^>]*>[\s\S]*?<BaseURL>([^<]+)<\/BaseURL>/g,
		),
	].map((match) => {
		const tag = match[0];
		const codecs = tag.match(/codecs="([^"]+)"/)?.[1] ?? "";
		return {
			width: Number(match[1]),
			height: Number(match[2]),
			url: match[3] as string,
			codecs,
		};
	});

	logger.info(
		`[instagram] dash variants: ${reps
			.map((r) => `${r.height}p ${r.codecs.split(".")[0] || "?"}`)
			.join(", ")}`,
	);

	const maxHeight = config.instagram.maxQuality;
	const withinCap = reps.filter((r) => r.height <= maxHeight);
	const h264WithinCap = withinCap.filter((r) => r.codecs.startsWith("avc"));
	const h264 = reps.filter((r) => r.codecs.startsWith("avc"));

	const sortedDesc = (rs: typeof reps) =>
		[...rs].sort((a, b) => b.height - a.height);
	const sortedAsc = (rs: typeof reps) =>
		[...rs].sort((a, b) => a.height - b.height);

	const best =
		sortedDesc(h264WithinCap).at(0) ??
		sortedDesc(withinCap).at(0) ??
		sortedAsc(h264).at(0) ??
		sortedAsc(reps).at(0);

	if (!best?.url || !audioMatch[1]) return null;

	logger.info(
		`[instagram] dash: picked ${best.height}p ${best.codecs || "?"} video + audio`,
	);

	return {
		videoUrl: best.url,
		audioUrl: audioMatch[1],
		width: best.width,
		height: best.height,
		codecCompatible: best.codecs.startsWith("avc"),
	};
};

const hasDirectMedia = (media: InstagramMedia): boolean =>
	!!media.video_versions?.length ||
	!!media.carousel_media?.length ||
	!!media.image_versions2?.candidates?.length;

export const findInstagramMedia = (
	value: unknown,
	shortcode: string,
): InstagramMedia | null => {
	if (value === null || typeof value !== "object") return null;
	const parsed = InstagramMediaSchema.safeParse(value);
	if (
		parsed.success &&
		hasDirectMedia(parsed.data) &&
		(parsed.data.code === shortcode || parsed.data.code === undefined)
	) {
		return parsed.data;
	}

	for (const child of Object.values(value as Record<string, unknown>)) {
		if (typeof child !== "object" || child === null) continue;
		const found = findInstagramMedia(child, shortcode);
		if (found) return found;
	}
	return null;
};

const findGraphMedia = (
	value: unknown,
	shortcode: string,
): InstagramGraphMedia | null => {
	if (value === null || typeof value !== "object") return null;
	const parsed = InstagramGraphMediaSchema.safeParse(value);
	if (
		parsed.success &&
		(parsed.data.video_url ||
			parsed.data.display_url ||
			parsed.data.edge_sidecar_to_children?.edges?.length) &&
		(parsed.data.shortcode === shortcode || parsed.data.shortcode === undefined)
	) {
		return parsed.data;
	}

	for (const child of Object.values(value as Record<string, unknown>)) {
		if (typeof child !== "object" || child === null) continue;
		const found = findGraphMedia(child, shortcode);
		if (found) return found;
	}
	return null;
};

const normalizeGraphMedia = (media: InstagramGraphMedia): InstagramMedia => {
	const width = media.dimensions?.width;
	const height = media.dimensions?.height;
	return {
		code: media.shortcode,
		...(media.video_url
			? { video_versions: [{ url: media.video_url, width, height }] }
			: {}),
		...(media.display_url
			? {
					image_versions2: {
						candidates: [{ url: media.display_url, width, height }],
					},
				}
			: {}),
		...(media.edge_sidecar_to_children?.edges
			? {
					carousel_media: media.edge_sidecar_to_children.edges
						.map((edge) => edge.node)
						.filter((node): node is InstagramGraphMedia => !!node)
						.map(normalizeGraphMedia),
				}
			: {}),
		video_duration: media.video_duration,
		original_width: width,
		original_height: height,
		owner: media.owner,
		caption: {
			text: media.edge_media_to_caption?.edges?.[0]?.node?.text,
		},
	};
};

export const findInstagramGraphMedia = (
	value: unknown,
	shortcode: string,
): InstagramMedia | null => {
	const media = findGraphMedia(value, shortcode);
	return media ? normalizeGraphMedia(media) : null;
};

const itemPlanOf = (
	item: InstagramMedia,
	headers: Record<string, string>,
): MediaItemPlan | null => {
	const duration = item.video_duration
		? Math.round(item.video_duration)
		: undefined;
	// fbcdn signed URLs are not IP-bound: pull bytes direct from the datacenter
	// link even when the post was extracted through the proxy, keeping the proxy
	// only as a fallback for edges that reject the datacenter IP.
	const directCtx = { forceProxy: false };
	const proxyCtx = getHttpContext() ?? { forceProxy: true };
	const sources: AtomicVideoSource[] = [];
	const streams = item.video_dash_manifest
		? parseDashManifest(item.video_dash_manifest)
		: null;
	if (streams) {
		sources.push({
			kind: "mux",
			videoUrl: streams.videoUrl,
			audioUrl: streams.audioUrl,
			videoCodecCompatible: streams.codecCompatible,
			httpContext: directCtx,
		});
	}
	const videoUrl = item.video_versions?.[0]?.url;
	if (videoUrl) {
		sources.push({
			kind: "download",
			url: videoUrl,
			headers,
			attempts: 2,
			connections: DOWNLOAD_CONNECTIONS,
			minBytesPerSecond: DOWNLOAD_MIN_BYTES_PER_SECOND,
			httpContext: directCtx,
		});
		sources.push({
			kind: "download",
			url: videoUrl,
			headers,
			attempts: 2,
			connections: DOWNLOAD_CONNECTIONS,
			httpContext: proxyCtx,
		});
	}
	if (sources.length > 0) {
		return {
			type: "video",
			source:
				sources.length === 1
					? (sources[0] as AtomicVideoSource)
					: { kind: "fallback", sources },
			width: streams?.width ?? item.original_width,
			height: streams?.height ?? item.original_height,
			duration,
		};
	}

	const image = item.image_versions2?.candidates?.[0];
	return image?.url
		? {
				type: "photo",
				source: {
					kind: "download",
					url: image.url,
					headers,
					attempts: 2,
				},
				width: image.width ?? item.original_width,
				height: image.height ?? item.original_height,
			}
		: null;
};

export const buildInstagramMediaPlan = (
	media: InstagramMedia,
	headers: Record<string, string> = CRAWLER_HEADERS,
): Flow<MediaPlan, ExtractionError> => {
	const caption = {
		author: media.user?.username ?? media.owner?.username,
		text: media.caption?.text,
	};

	if (media.carousel_media?.length) {
		const items = media.carousel_media
			.map((item) => itemPlanOf(item, headers))
			.filter((item): item is MediaItemPlan => item !== null);
		return items.length > 0
			? F.of({
					type: "carousel",
					items,
					caption,
					concurrency: 2,
					maxBytes: config.telegram.maxCarouselBytes,
				})
			: F.fail(extractionError("NO_MEDIA", "no carousel media urls"));
	}

	const item = itemPlanOf(media, headers);
	return item
		? F.of({ ...item, caption } as MediaPlan)
		: F.fail(extractionError("NO_MEDIA", "no media url"));
};
