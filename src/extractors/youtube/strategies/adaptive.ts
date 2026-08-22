import type { ExtractionError, Flow } from "lib";
import type { Caption } from "extractors/types";
import type { MediaPlan } from "extractors/media";
import type {
	InnertubeFormat,
	InnertubeResponse,
} from "extractors/youtube/types";

import { config } from "config";
import { extractionError, F, defineStrategy, logger } from "lib";
import { CLIENTS } from "extractors/youtube/constants";
import {
	estimatedBytesOf,
	extractVideoId,
	fetchVideoData,
	resolveVideoData,
} from "extractors/youtube/utils";

type AdaptiveStreams = {
	videoUrl: string;
	audioUrl: string;
	width?: number;
	height?: number;
	duration?: number;
	codecCompatible: boolean;
	userAgent: string;
	caption: Caption;
};

const codecOf = (format: InnertubeFormat): string =>
	format.mimeType?.match(/codecs="([^"]+)"/)?.[1] ?? "";

const filterByMime = (
	formats: InnertubeFormat[],
	prefix: string,
): InnertubeFormat[] =>
	formats.filter(({ url, mimeType }) => url && mimeType?.startsWith(prefix));

const selectAdaptiveStreams = (
	data: InnertubeResponse,
	userAgent: string,
): Flow<AdaptiveStreams, ExtractionError> => {
	const adaptive = data.streamingData?.adaptiveFormats ?? [];
	const duration = data.videoDetails?.lengthSeconds
		? Number.parseInt(data.videoDetails.lengthSeconds, 10)
		: undefined;

	const videos = filterByMime(adaptive, "video/").sort(
		(a, b) => (b.height ?? 0) - (a.height ?? 0),
	);
	const audios = filterByMime(adaptive, "audio/").sort(
		(a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0),
	);
	const originals = audios.filter(
		({ audioTrack }) =>
			audioTrack?.audioIsDefault ||
			audioTrack?.displayName?.toLowerCase().includes("original"),
	);
	const nonDubbed = audios.filter(
		({ audioTrack }) => audioTrack?.isAutoDubbed !== true,
	);

	const h264 = videos.filter((v) => codecOf(v).startsWith("avc"));
	const videoPool = h264.length > 0 ? h264 : videos;
	const bestAudio =
		(originals.length > 0 ? originals : nonDubbed)[0] ?? audios[0];
	const audioBytes = bestAudio
		? estimatedBytesOf(bestAudio, duration)
		: undefined;
	const fittingVideos = videoPool.filter((video) => {
		const videoBytes = estimatedBytesOf(video, duration);
		return (
			videoBytes === undefined ||
			audioBytes === undefined ||
			videoBytes + audioBytes <= config.telegram.maxFileSize
		);
	});

	const bestVideo =
		fittingVideos.find(
			({ height }) => (height ?? 0) <= config.youtube.maxQuality,
		) ?? fittingVideos.at(-1);

	if (!bestVideo?.url || !bestAudio?.url) {
		return F.fail(extractionError("NO_MEDIA", "no adaptive YouTube streams"));
	}

	const videoCodec = codecOf(bestVideo);
	logger.info(
		`[youtube] adaptive ${bestVideo.width}x${bestVideo.height} ${videoCodec || "?"}`,
	);

	const caption: Caption = {
		author: data.videoDetails?.author,
		text: data.videoDetails?.title,
	};

	return F.of({
		videoUrl: bestVideo.url,
		audioUrl: bestAudio.url,
		width: bestVideo.width,
		height: bestVideo.height,
		duration,
		codecCompatible: videoCodec.startsWith("avc"),
		userAgent,
		caption,
	});
};

const buildPlan = ({
	videoUrl,
	audioUrl,
	width,
	height,
	duration,
	codecCompatible,
	userAgent,
	caption,
}: AdaptiveStreams): Flow<MediaPlan, ExtractionError> => {
	return F.of({
		type: "video",
		source: {
			kind: "mux",
			videoUrl,
			audioUrl,
			headers: { "User-Agent": userAgent },
			videoCodecCompatible: codecCompatible,
		},
		width,
		height,
		duration,
		caption,
	});
};

export const adaptive = defineStrategy(
	"adaptive",
	async (url: string, context): Promise<Flow<MediaPlan, ExtractionError>> => {
		const videoId = extractVideoId(url);
		if (!videoId) {
			return F.fail(extractionError("NOT_APPLICABLE", "no YouTube video ID"));
		}

		const skip: string[] = [];
		for (let attempt = 0; attempt < CLIENTS.length; attempt++) {
			const resultFlow =
				attempt === 0
					? await resolveVideoData(videoId, context)
					: await fetchVideoData(videoId, skip);
			if (resultFlow._tag !== "Continue") return resultFlow;

			const { data, client } = resultFlow.value;

			const streamsFlow = selectAdaptiveStreams(data, client.userAgent);
			if (streamsFlow._tag !== "Continue") {
				skip.push(client.name);
				continue;
			}

			return buildPlan(streamsFlow.value);
		}
		return F.fail(extractionError("NO_MEDIA", "all YouTube clients exhausted"));
	},
);
