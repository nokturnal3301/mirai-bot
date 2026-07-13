import type { ExtractionError, Flow } from "lib";
import type { Caption } from "extractors/types";
import type { MediaPlan } from "extractors/media";
import type {
	InnertubeFormat,
	InnertubeResult,
} from "extractors/youtube/types";

import { config } from "config";
import { extractionError, F, chain, defineStrategy } from "lib";
import {
	DOWNLOAD_CONNECTIONS,
	DOWNLOAD_MIN_BYTES_PER_SECOND,
} from "extractors/youtube/constants";
import {
	estimatedBytesOf,
	extractVideoId,
	resolveVideoData,
} from "extractors/youtube/utils";

type SelectedFormat = {
	format: InnertubeFormat;
	duration?: number;
	userAgent: string;
	caption: Caption;
};

const selectBestFormat = ({
	data,
	client,
}: InnertubeResult): Flow<SelectedFormat, ExtractionError> => {
	const formats = data.streamingData?.formats ?? [];
	const duration = data.videoDetails?.lengthSeconds
		? Number.parseInt(data.videoDetails.lengthSeconds, 10)
		: undefined;

	const videos = formats
		.filter(({ url, mimeType }) => url && mimeType?.startsWith("video/"))
		.filter((format) => {
			const bytes = estimatedBytesOf(format, duration);
			return bytes === undefined || bytes <= config.telegram.maxFileSize;
		})
		.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));

	const bestVideo =
		videos.find(({ height }) => (height ?? 0) <= config.youtube.maxQuality) ??
		videos[videos.length - 1];

	if (!bestVideo) {
		return F.fail(extractionError("NO_MEDIA", "no combined YouTube format"));
	}

	const caption: Caption = {
		author: data.videoDetails?.author,
		text: data.videoDetails?.title,
	};

	return F.of({
		format: bestVideo,
		duration,
		userAgent: client.userAgent,
		caption,
	});
};

const buildPlan = (
	selected: SelectedFormat,
): Flow<MediaPlan, ExtractionError> => {
	const { format, duration, userAgent, caption } = selected;
	if (!format.url) {
		return F.fail(extractionError("NO_MEDIA", "no YouTube format URL"));
	}

	const size = format.contentLength
		? Number.parseInt(format.contentLength, 10)
		: undefined;
	return F.of({
		type: "video",
		source: {
			kind: "download",
			url: format.url,
			headers: { "User-Agent": userAgent },
			connections: DOWNLOAD_CONNECTIONS,
			...(Number.isFinite(size) ? { expectedBytes: size } : {}),
			minBytesPerSecond: DOWNLOAD_MIN_BYTES_PER_SECOND,
		},
		width: format.width,
		height: format.height,
		duration,
		caption,
	});
};

export const combined = defineStrategy(
	"combined",
	(url: string, context): Promise<Flow<MediaPlan, ExtractionError>> =>
		chain(F.of(url))
			.pipe((url) =>
				F.failIfNull(
					extractionError("NOT_APPLICABLE", "no YouTube video ID"),
					extractVideoId(url),
				),
			)
			.pipe((videoId) => resolveVideoData(videoId, context))
			.pipe(selectBestFormat)
			.pipe(buildPlan)
			.run(),
);
