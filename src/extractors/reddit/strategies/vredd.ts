import type { ExtractionError, Flow } from "lib";
import type { AtomicVideoSource, MediaPlan } from "extractors/media";

import {
	extractionError,
	extractionErrorFrom,
	F,
	chain,
	defineStrategy,
	http,
	logger,
} from "lib";
import { DOWNLOAD_MIN_BYTES_PER_SECOND } from "extractors/constants";
import { parseDash } from "extractors/utils";
import { DOWNLOAD_CONNECTIONS, HEADERS } from "extractors/reddit/constants";
import { extractVReddId } from "extractors/reddit/utils";

type DashStreams = {
	videoId: string;
	videoUrl: string;
	audioUrl: string | null;
	width?: number;
	height?: number;
};

const parseManifest = (
	videoId: string,
	manifest: string,
): DashStreams | null => {
	const { audioUrl: audio, videos } = parseDash(manifest);
	const best = [...videos].sort((a, b) => b.bandwidth - a.bandwidth)[0];
	if (!best) return null;

	const videoUrl = `https://v.redd.it/${videoId}/${best.url}`;
	const audioUrl = audio ? `https://v.redd.it/${videoId}/${audio}` : null;

	logger.info(
		`[reddit/vredd] ${best.width}x${best.height} ${(best.bandwidth / 1000).toFixed(0)}kbps audio=${!!audioUrl}`,
	);

	return {
		videoId,
		videoUrl,
		audioUrl,
		width: best.width,
		height: best.height,
	};
};

const fetchManifest = async (
	url: string,
): Promise<Flow<DashStreams, ExtractionError>> => {
	const videoId = extractVReddId(url);
	if (!videoId) {
		return F.fail(extractionError("NOT_APPLICABLE", "not a v.redd.it URL"));
	}

	try {
		const manifest = await http(
			`https://v.redd.it/${videoId}/DASHPlaylist.mpd`,
			{ headers: HEADERS, responseType: "text" },
		);
		const streams = parseManifest(videoId, manifest);
		return F.failIfNull(
			extractionError("NO_MEDIA", "no streams in Reddit DASH manifest"),
			streams,
		);
	} catch (error) {
		return F.fail(extractionErrorFrom(error));
	}
};

const buildPlan = (streams: DashStreams): Flow<MediaPlan, ExtractionError> => {
	const sources: AtomicVideoSource[] = [];
	if (streams.audioUrl) {
		sources.push({
			kind: "mux",
			videoUrl: streams.videoUrl,
			audioUrl: streams.audioUrl,
			videoCodecCompatible: true,
		});
	}
	sources.push({
		kind: "download",
		url: streams.videoUrl,
		headers: HEADERS,
		connections: DOWNLOAD_CONNECTIONS,
		minBytesPerSecond: DOWNLOAD_MIN_BYTES_PER_SECOND,
	});

	return F.of({
		type: "video",
		source:
			sources.length === 1
				? (sources[0] as AtomicVideoSource)
				: { kind: "fallback", sources },
		width: streams.width,
		height: streams.height,
	});
};

export const vredd = defineStrategy(
	"vredd",
	(url: string): Promise<Flow<MediaPlan, ExtractionError>> =>
		chain(F.of(url)).pipe(fetchManifest).pipe(buildPlan).run(),
);
