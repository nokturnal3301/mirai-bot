import type { ExtractionError, Flow } from "lib";
import type { Caption } from "extractors/types";
import type {
	AtomicVideoSource,
	MediaItemPlan,
	MediaPlan,
} from "extractors/media";
import type { RedditPost } from "extractors/reddit/types";

import {
	extractionError,
	F,
	chain,
	defineStrategy,
	http,
	HttpStatusError,
	logger,
} from "lib";
import { HEADERS, IMAGE_HEADERS } from "extractors/reddit/constants";
import { RedditListingSchema } from "extractors/reddit/schemas";
import {
	decodeHtmlEntities,
	extractPostId,
	extractShareId,
	extractShortId,
	getRedditCookies,
	invalidateRedditCookies,
	isNativeMediaUrl,
	refreshRedditSession,
} from "extractors/reddit/utils";

const headersWithCookies = async () => ({
	...HEADERS,
	Cookie: await getRedditCookies(),
});

const resolveUrl = async (
	url: string,
): Promise<Flow<string, ExtractionError>> => {
	if (extractPostId(url)) return F.of(url);

	if (extractShortId(url) || extractShareId(url)) {
		const response = await http(url, {
			headers: await headersWithCookies(),
			redirect: "manual",
			responseType: "raw",
			proxy: true,
		});
		const location = response.headers.get("location");
		if (location) return F.of(location);
		return F.fail(
			extractionError("UPSTREAM_REJECTED", "could not resolve short URL"),
		);
	}

	return F.fail(extractionError("NOT_APPLICABLE", "not a Reddit post URL"));
};

const fetchPost = async (
	url: string,
): Promise<Flow<RedditPost, ExtractionError>> => {
	const jsonUrl = `${url.replace(/\?.*$/, "").replace(/\/?$/, "")}.json`;

	let raw: unknown;
	try {
		raw = await http<unknown>(jsonUrl, {
			headers: await headersWithCookies(),
			responseType: "json",
			proxy: true,
		});
	} catch (err) {
		if (
			!(err instanceof HttpStatusError) ||
			(err.status !== 401 && err.status !== 403)
		) {
			throw err;
		}
		logger.warn("[reddit/json] auth failed, refreshing challenge cookies");
		invalidateRedditCookies();
		try {
			await refreshRedditSession(url);
		} catch (error) {
			logger.warn(
				`[reddit/json] shreddit session failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		raw = await http<unknown>(jsonUrl, {
			headers: await headersWithCookies(),
			responseType: "json",
			proxy: true,
		});
	}

	const parsed = RedditListingSchema.safeParse(raw);
	if (!parsed.success) {
		logger.warn(`[reddit/json] schema mismatch: ${parsed.error.message}`);
		return F.fail(
			extractionError("SCHEMA_MISMATCH", "Reddit listing schema mismatch"),
		);
	}

	const post = parsed.data[0]?.data?.children?.[0]?.data;
	return F.failIfNull(
		extractionError("NO_MEDIA", "no post in Reddit listing"),
		post,
	);
};

const captionOf = (post: RedditPost): Caption => {
	const title = post.title?.trim();
	const selftext = post.selftext?.trim();
	const text = [title, selftext].filter(Boolean).join("\n\n");
	return { author: post.author, text };
};

const buildGalleryPlan = (
	post: RedditPost,
): Flow<MediaPlan, ExtractionError> => {
	const ids = post.gallery_data?.items?.map((i) => i.media_id) ?? [];
	const items: MediaItemPlan[] = ids.map((id) => {
		const meta = post.media_metadata?.[id];
		const ext = meta?.m?.split("/")[1] ?? "jpg";
		const url = meta?.s?.u ?? meta?.s?.url ?? `https://i.redd.it/${id}.${ext}`;
		return {
			type: "photo",
			source: {
				kind: "download",
				url: decodeHtmlEntities(url),
				headers: IMAGE_HEADERS,
			},
			width: meta?.s?.x ?? meta?.s?.width,
			height: meta?.s?.y ?? meta?.s?.height,
		};
	});

	if (items.length === 0) {
		return F.fail(extractionError("NO_MEDIA", "no gallery media URLs"));
	}
	return F.of({ type: "carousel", items, caption: captionOf(post) });
};

const buildVideoPlan = async (
	post: RedditPost,
): Promise<Flow<MediaPlan, ExtractionError>> => {
	const video = post.media?.reddit_video;
	if (!video?.fallback_url) {
		return F.fail(extractionError("NO_MEDIA", "no Reddit video fallback URL"));
	}

	const videoUrl = video.fallback_url.split("?")[0] ?? video.fallback_url;
	const videoId = videoUrl.match(/v\.redd\.it\/([\w]+)\//)?.[1];
	if (!videoId) {
		return F.fail(
			extractionError("SCHEMA_MISMATCH", "invalid v.redd.it video ID"),
		);
	}

	const audioCandidates = [
		`https://v.redd.it/${videoId}/DASH_AUDIO_128.mp4`,
		`https://v.redd.it/${videoId}/DASH_AUDIO_64.mp4`,
		`https://v.redd.it/${videoId}/DASH_audio.mp4`,
	];

	const probeController = new AbortController();
	const probes = audioCandidates.map((candidate) => ({
		candidate,
		available: (async () => {
			try {
				await http(candidate, {
					method: "HEAD",
					responseType: "raw",
					attempts: 1,
					timeout: 3_000,
					signal: probeController.signal,
				});
				return true;
			} catch {
				return false;
			}
		})(),
	}));
	let audioUrl: string | undefined;
	try {
		for (const probe of probes) {
			if (await probe.available) {
				audioUrl = probe.candidate;
				break;
			}
		}
	} finally {
		probeController.abort("audio variant selected");
	}
	const sources: AtomicVideoSource[] = [];

	if (audioUrl) {
		sources.push({
			kind: "mux",
			videoUrl,
			audioUrl,
			videoCodecCompatible: true,
		});
	}
	sources.push({
		kind: "download",
		url: videoUrl,
		headers: HEADERS,
	});

	return F.of({
		type: "video",
		source:
			sources.length === 1
				? (sources[0] as AtomicVideoSource)
				: { kind: "fallback", sources },
		width: video.width,
		height: video.height,
		duration: video.duration,
		caption: captionOf(post),
	});
};

const buildImagePlan = (post: RedditPost): Flow<MediaPlan, ExtractionError> => {
	const url = post.url ?? post.url_overridden_by_dest;
	if (!url) return F.fail(extractionError("NO_MEDIA", "no Reddit image URL"));

	const source = post.preview?.images?.[0]?.source;

	return F.of({
		type: "photo",
		source: { kind: "download", url, headers: IMAGE_HEADERS },
		width: source?.width,
		height: source?.height,
		caption: captionOf(post),
	});
};

const buildTextPost = (post: RedditPost): Flow<MediaPlan, ExtractionError> => {
	const title = post.title?.trim();
	const selftext = post.selftext?.trim();
	const externalUrl =
		!post.is_self &&
		post.url &&
		!isNativeMediaUrl(post.url) &&
		!/reddit\.com\/r\//.test(post.url)
			? post.url
			: undefined;

	const parts = [title, selftext, externalUrl].filter(Boolean) as string[];
	const text = parts.join("\n\n");
	if (!text) return F.stop();

	return F.of({
		type: "text",
		caption: { author: post.author, text },
	});
};

const buildPlan = async (
	post: RedditPost,
): Promise<Flow<MediaPlan, ExtractionError>> => {
	if (post.is_gallery && post.gallery_data?.items?.length) {
		return buildGalleryPlan(post);
	}

	if (post.is_video) return buildVideoPlan(post);

	const url = post.url ?? post.url_overridden_by_dest ?? "";

	if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url) || /i\.redd\.it/.test(url)) {
		return buildImagePlan(post);
	}

	if (/v\.redd\.it/.test(url)) return buildVideoPlan(post);

	logger.info(`[reddit/json] text post (domain=${post.domain})`);
	return buildTextPost(post);
};

export const json = defineStrategy(
	"json",
	(url: string): Promise<Flow<MediaPlan, ExtractionError>> =>
		chain(F.of(url)).pipe(resolveUrl).pipe(fetchPost).pipe(buildPlan).run(),
);
