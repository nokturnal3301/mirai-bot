import type { MediaPlan } from "extractors/media";
import type { InstagramMedia } from "extractors/instagram/schemas";
import type { ExtractionError, Flow, StrategyContext } from "lib";

import {
	CRAWLER_HEADERS,
	SCRIPT_PATTERN,
} from "extractors/instagram/constants";
import {
	buildInstagramMediaPlan,
	extractShortcode,
	findInstagramMedia,
} from "extractors/instagram/utils";
import { extractionError, F, chain, defineStrategy, http, logger } from "lib";

const fetchPost = async (
	shortcode: string,
	signal: AbortSignal,
): Promise<Flow<InstagramMedia, ExtractionError>> => {
	const html = await http(`https://www.instagram.com/reel/${shortcode}/`, {
		headers: CRAWLER_HEADERS,
		responseType: "text",
		attempts: 1,
		signal,
	});

	for (const match of html.matchAll(SCRIPT_PATTERN)) {
		const raw = match[1];
		if (!raw || !raw.includes(shortcode)) continue;
		try {
			const media = findInstagramMedia(JSON.parse(raw), shortcode);
			if (media) return F.of(media);
		} catch {
			// Try the next structured payload.
		}
	}

	logger.warn("[instagram/ssr] media node not found");
	return F.fail(extractionError("NO_MEDIA", "no media in Instagram SSR"));
};

export const ssr = defineStrategy(
	"ssr",
	(
		url: string,
		context: StrategyContext,
	): Promise<Flow<MediaPlan, ExtractionError>> =>
		chain(F.of(url))
			.pipe((url) =>
				F.failIfNull(
					extractionError("NOT_APPLICABLE", "no Instagram shortcode"),
					extractShortcode(url),
				),
			)
			.pipe((shortcode) => fetchPost(shortcode, context.signal))
			.pipe(buildInstagramMediaPlan)
			.run(),
);
