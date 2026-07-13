import type { ExtractionError, Flow } from "lib";
import type { Caption } from "extractors/types";
import type { MediaItemPlan, MediaPlan } from "extractors/media";
import type { MediaDetail } from "extractors/twitter/types";

import { extractionError, F, chain, defineStrategy, http, logger } from "lib";
import { config } from "config";
import {
	DOWNLOAD_CONNECTIONS,
	DOWNLOAD_MIN_BYTES_PER_SECOND,
	HEADERS,
} from "extractors/twitter/constants";
import { SyndicationResponseSchema } from "extractors/twitter/schemas";
import { extractTweetId, tweetToken } from "extractors/twitter/utils";

const sortedMp4Variants = (
	detail: MediaDetail,
): { url: string; bitrate: number }[] =>
	(detail.video_info?.variants ?? [])
		.filter((v) => v.content_type === "video/mp4")
		.map((v) => ({ url: v.url, bitrate: v.bitrate ?? 0 }))
		.sort((a, b) => b.bitrate - a.bitrate);

const probeSize = async (
	url: string,
	signal: AbortSignal,
): Promise<number | null> => {
	try {
		const r = await http(url, {
			method: "HEAD",
			responseType: "raw",
			attempts: 1,
			timeout: 5_000,
			signal,
		});
		const len = Number(r.headers.get("content-length") ?? 0);
		return len > 0 ? len : null;
	} catch {
		return null;
	}
};

type PickedVideo = { url: string; size?: number };

const pickVideoUrl = async (
	detail: MediaDetail,
): Promise<PickedVideo | null> => {
	const variants = sortedMp4Variants(detail);
	const controller = new AbortController();
	const probes = variants.map((variant) => ({
		variant,
		size: probeSize(variant.url, controller.signal),
	}));

	try {
		for (const { variant, size: pendingSize } of probes) {
			const size = await pendingSize;
			if (size !== null && size <= config.telegram.maxFileSize) {
				logger.info(
					`[twitter] picked ${variant.bitrate}bps variant (${(size / 1024 / 1024).toFixed(1)}MB)`,
				);
				return { url: variant.url, size };
			}
		}
	} finally {
		controller.abort("video variant selected");
	}

	logger.warn("[twitter] no variant fits under file size limit");
	const fallback = variants.at(-1)?.url;
	return fallback ? { url: fallback } : null;
};

const itemPlanOf = async (
	detail: MediaDetail,
): Promise<MediaItemPlan | null> => {
	const width = detail.original_info?.width;
	const height = detail.original_info?.height;

	if (detail.type === "photo") {
		const url = detail.media_url_https;
		if (!url) return null;

		return {
			type: "photo",
			source: {
				kind: "download",
				url,
				headers: HEADERS,
				attempts: 2,
			},
			width,
			height,
		};
	}

	const picked = await pickVideoUrl(detail);
	if (!picked) return null;

	const duration = detail.video_info?.duration_millis
		? Math.round(detail.video_info.duration_millis / 1000)
		: undefined;

	return {
		type: "video",
		source: {
			kind: "download",
			url: picked.url,
			headers: HEADERS,
			attempts: 2,
			connections: DOWNLOAD_CONNECTIONS,
			minBytesPerSecond: DOWNLOAD_MIN_BYTES_PER_SECOND,
			...(picked.size !== undefined ? { expectedBytes: picked.size } : {}),
		},
		width,
		height,
		duration,
	};
};

const fetchTweet = async (
	tweetId: string,
): Promise<
	Flow<{ details: MediaDetail[]; caption: Caption }, ExtractionError>
> => {
	const token = tweetToken(tweetId);
	const url = `https://cdn.syndication.twitter.com/tweet-result?id=${tweetId}&token=${token}&lang=en`;

	const raw = await http<unknown>(url, {
		headers: HEADERS,
		responseType: "json",
	});

	const parsed = SyndicationResponseSchema.safeParse(raw);
	if (!parsed.success) {
		logger.warn(
			`[twitter/syndication] schema mismatch: ${parsed.error.message}`,
		);
		return F.fail(
			extractionError("SCHEMA_MISMATCH", "Twitter syndication schema mismatch"),
		);
	}

	const details = parsed.data.mediaDetails ?? [];

	const noteTweet = (parsed.data as { note_tweet?: unknown }).note_tweet;
	const text = noteTweet ? `${parsed.data.text ?? ""}…` : parsed.data.text;

	const caption: Caption = {
		source: "twitter",
		author: parsed.data.user?.screen_name,
		text,
	};

	return F.of({ details, caption });
};

const buildPlan = async ({
	details,
	caption,
}: {
	details: MediaDetail[];
	caption: Caption;
}): Promise<Flow<MediaPlan, ExtractionError>> => {
	if (details.length === 0) {
		if (caption.text) return F.of({ type: "text", caption });
		return F.fail(extractionError("NO_MEDIA", "no media in tweet"));
	}

	if (details.length === 1) {
		const item = await itemPlanOf(details[0] as MediaDetail);
		if (!item) {
			return F.fail(extractionError("NO_MEDIA", "no Twitter media URL"));
		}

		if (item.type === "video") {
			return F.of({
				type: "video",
				source: item.source,
				width: item.width,
				height: item.height,
				duration: item.duration,
				caption,
			});
		}
		return F.of({
			type: "photo",
			source: item.source,
			width: item.width,
			height: item.height,
			caption,
		});
	}

	const items = (await Promise.all(details.map(itemPlanOf))).filter(
		(item): item is MediaItemPlan => item !== null,
	);
	if (items.length === 0) {
		return F.fail(extractionError("NO_MEDIA", "no Twitter media URLs"));
	}
	return F.of({ type: "carousel", items, caption });
};

export const syndication = defineStrategy(
	"syndication",
	(url: string): Promise<Flow<MediaPlan, ExtractionError>> =>
		chain(F.of(url))
			.pipe((url) =>
				F.failIfNull(
					extractionError("NOT_APPLICABLE", "no tweet id"),
					extractTweetId(url),
				),
			)
			.pipe(fetchTweet)
			.pipe(buildPlan)
			.run(),
);
