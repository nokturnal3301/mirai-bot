import { config } from "config";
import { DOWNLOAD_CONNECTIONS } from "extractors/constants";
import {
	directThenProxy,
	planOfItem,
	type AtomicVideoSource,
	type AudioPlan,
	type MediaItemPlan,
	type MediaPlan,
} from "extractors/media";
import type { Caption } from "extractors/types";
import { findDeep, parseDash } from "extractors/utils";
import type {
	InstagramGraphMedia,
	InstagramMedia,
} from "extractors/instagram/schemas";
import { InstagramGraphMediaSchema, InstagramMediaSchema } from "./schemas";
import { CRAWLER_HEADERS } from "./constants";
import {
	decodeHtmlEntities,
	extractionError,
	F,
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

// fbcdn signed URLs are not IP-bound, so media bytes always try the fast
// datacenter link first, even when the post came through the proxy.
const DIRECT = { forceProxy: false };

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
	const { audioUrl, videos } = parseDash(manifest);
	if (!audioUrl || videos.length === 0) return null;

	logger.info(
		`[instagram] dash variants: ${videos
			.map((r) => `${r.height}p ${r.codecs.split(".")[0] || "?"}`)
			.join(", ")}`,
	);

	const isH264 = (r: (typeof videos)[number]) => r.codecs.startsWith("avc");
	const withinCap = videos.filter(
		(r) => r.height <= config.instagram.maxQuality,
	);
	const tallest = (rs: typeof videos) =>
		[...rs].sort((a, b) => b.height - a.height).at(0);
	const shortest = (rs: typeof videos) =>
		[...rs].sort((a, b) => a.height - b.height).at(0);

	const best =
		tallest(withinCap.filter(isH264)) ??
		tallest(withinCap) ??
		shortest(videos.filter(isH264)) ??
		shortest(videos);
	if (!best) return null;

	logger.info(
		`[instagram] dash: picked ${best.height}p ${best.codecs || "?"} video + audio`,
	);

	return {
		videoUrl: best.url,
		audioUrl,
		width: best.width,
		height: best.height,
		codecCompatible: isH264(best),
	};
};

const hasDirectMedia = (media: InstagramMedia): boolean =>
	!!media.video_versions?.length ||
	!!media.carousel_media?.length ||
	!!media.image_versions2?.candidates?.length;

export const findInstagramMedia = (
	value: unknown,
	shortcode: string,
): InstagramMedia | null =>
	findDeep(value, (node) => {
		const { data } = InstagramMediaSchema.safeParse(node);
		return data &&
			hasDirectMedia(data) &&
			(data.code === shortcode || data.code === undefined)
			? data
			: null;
	});

const findGraphMedia = (
	value: unknown,
	shortcode: string,
): InstagramGraphMedia | null =>
	findDeep(value, (node) => {
		const { data } = InstagramGraphMediaSchema.safeParse(node);
		return data &&
			(data.video_url ||
				data.display_url ||
				data.edge_sidecar_to_children?.edges?.length) &&
			(data.shortcode === shortcode || data.shortcode === undefined)
			? data
			: null;
	});

const graphMusicOf = (
	media: InstagramGraphMedia,
): InstagramMedia["clips_metadata"] => {
	const music = media.clips_music_attribution_info;
	if (!music?.song_name) return undefined;
	return music.uses_original_audio
		? {
				original_sound_info: {
					original_audio_title: music.song_name,
					ig_artist: { username: music.artist_name },
				},
			}
		: {
				music_info: {
					music_asset_info: {
						title: music.song_name,
						display_artist: music.artist_name,
					},
				},
			};
};

const normalizeGraphMedia = (media: InstagramGraphMedia): InstagramMedia => {
	const width = media.dimensions?.width;
	const height = media.dimensions?.height;
	return {
		code: media.shortcode,
		video_versions: media.video_url
			? [{ url: media.video_url, width, height }]
			: undefined,
		image_versions2: media.display_url
			? { candidates: [{ url: media.display_url, width, height }] }
			: undefined,
		carousel_media: media.edge_sidecar_to_children?.edges
			?.map((edge) => edge.node)
			.filter((node): node is InstagramGraphMedia => !!node)
			.map(normalizeGraphMedia),
		video_duration: media.video_duration,
		original_width: width,
		original_height: height,
		owner: media.owner,
		caption: {
			text: media.edge_media_to_caption?.edges?.[0]?.node?.text,
		},
		taken_at: media.taken_at_timestamp,
		like_count:
			media.edge_liked_by?.count ?? media.edge_media_preview_like?.count,
		comment_count:
			media.edge_media_to_comment?.count ??
			media.edge_media_to_parent_comment?.count,
		view_count: media.video_view_count,
		like_and_view_counts_disabled: media.like_and_view_counts_disabled,
		clips_metadata: graphMusicOf(media),
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
	const streams = item.video_dash_manifest
		? parseDashManifest(item.video_dash_manifest)
		: null;
	const videoUrl = item.video_versions?.[0]?.url;
	const sources: AtomicVideoSource[] = [
		...(streams
			? [
					{
						kind: "mux" as const,
						videoUrl: streams.videoUrl,
						audioUrl: streams.audioUrl,
						videoCodecCompatible: streams.codecCompatible,
						httpContext: DIRECT,
					},
				]
			: []),
		...(videoUrl
			? directThenProxy({
					kind: "download",
					url: videoUrl,
					headers,
					attempts: 2,
					connections: DOWNLOAD_CONNECTIONS,
				})
			: []),
	];
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
					httpContext: DIRECT,
				},
				width: image.width ?? item.original_width,
				height: image.height ?? item.original_height,
			}
		: null;
};

const musicOf = (media: InstagramMedia): string | undefined => {
	const track =
		media.clips_metadata?.music_info?.music_asset_info ??
		media.music_metadata?.music_info?.music_asset_info;
	if (track?.title) {
		return decodeHtmlEntities(
			[track.title, track.display_artist].filter(Boolean).join(" — "),
		);
	}
	const original =
		media.clips_metadata?.original_sound_info ??
		media.music_metadata?.original_sound_info;
	if (!original) return undefined;
	return decodeHtmlEntities(
		[
			original.original_audio_title || "Original audio",
			original.ig_artist?.username,
		]
			.filter(Boolean)
			.join(" — "),
	);
};

export const instagramCaptionOf = (media: InstagramMedia): Caption => {
	const user = media.user ?? media.owner;
	const hidden = media.like_and_view_counts_disabled === true;
	const isVideo = media.media_type === 2 || !!media.video_versions?.length;
	const views = isVideo
		? (media.view_count ?? media.play_count ?? media.ig_play_count)
		: undefined;
	const stats = {
		...(views != null && !hidden ? { views } : {}),
		...(media.like_count != null && !hidden ? { likes: media.like_count } : {}),
		...(media.comment_count != null ? { comments: media.comment_count } : {}),
	};
	return {
		author: user?.username || undefined,
		name: user?.full_name || undefined,
		verified: user?.is_verified || undefined,
		text: media.caption?.text || undefined,
		stats: Object.keys(stats).length > 0 ? stats : undefined,
		postedAt: media.taken_at || undefined,
		music: musicOf(media),
	};
};

// Photo posts can carry a licensed track; send it after the media like
// TikTok photo slideshows.
const audioOf = (
	media: InstagramMedia,
	headers: Record<string, string>,
): AudioPlan | undefined => {
	const track = media.music_metadata?.music_info?.music_asset_info;
	if (!track?.progressive_download_url) return undefined;
	return {
		source: {
			kind: "download",
			url: track.progressive_download_url,
			headers,
			attempts: 2,
			httpContext: DIRECT,
		},
		duration: track.duration_in_ms
			? Math.round(track.duration_in_ms / 1000)
			: undefined,
		title: track.title ?? undefined,
		performer: track.display_artist ?? undefined,
	};
};

export const buildInstagramMediaPlan = (
	media: InstagramMedia,
	headers: Record<string, string> = CRAWLER_HEADERS,
): Flow<MediaPlan, ExtractionError> => {
	const audioRestriction =
		media.clips_metadata?.music_info?.music_consumption_info;
	const isVideo =
		media.media_type === 2 ||
		!!media.video_versions?.length ||
		!!media.video_dash_manifest;
	if (
		isVideo &&
		media.has_audio === false &&
		audioRestriction?.should_mute_audio === true
	) {
		return F.fail(
			extractionError(
				"UPSTREAM_REJECTED",
				audioRestriction.should_mute_audio_reason ||
					"Instagram muted audio in this region",
				{ retryable: true },
			),
		);
	}

	const caption = instagramCaptionOf(media);
	const audio = isVideo ? undefined : audioOf(media, headers);

	if (media.carousel_media?.length) {
		const items = media.carousel_media
			.map((item) => itemPlanOf(item, headers))
			.filter((item): item is MediaItemPlan => item !== null);
		return items.length > 0
			? F.of({
					type: "carousel",
					items,
					caption,
					audio,
					maxBytes: config.telegram.maxCarouselBytes,
				})
			: F.fail(extractionError("NO_MEDIA", "no carousel media urls"));
	}

	const item = itemPlanOf(media, headers);
	if (!item) return F.fail(extractionError("NO_MEDIA", "no media url"));
	return audio && item.type === "photo"
		? F.of({ type: "carousel", items: [item], caption, audio })
		: F.of(planOfItem(item, caption));
};
