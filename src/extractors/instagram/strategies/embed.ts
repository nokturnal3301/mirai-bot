import type { MediaPlan } from "extractors/media";
import type { InstagramMedia } from "extractors/instagram/schemas";
import type { ExtractionError, Flow, StrategyContext } from "lib";

import { HEADERS } from "extractors/instagram/constants";
import {
	buildInstagramMediaPlan,
	extractShortcode,
	findInstagramGraphMedia,
	findInstagramMedia,
} from "extractors/instagram/utils";
import { extractionError, F, chain, defineStrategy, http } from "lib";

const CONTEXT_JSON_PATTERN = /"contextJSON":"((?:\\.|[^"\\])*)"/g;

export const parseEmbedMedia = (
	html: string,
	shortcode: string,
): InstagramMedia | null => {
	for (const match of html.matchAll(CONTEXT_JSON_PATTERN)) {
		const escaped = match[1];
		if (!escaped) continue;
		try {
			const decoded = JSON.parse(`"${escaped}"`);
			const payload: unknown = JSON.parse(decoded);
			const media =
				findInstagramMedia(payload, shortcode) ??
				findInstagramGraphMedia(payload, shortcode);
			if (media) return media;
		} catch {
			// Keep looking for another init payload.
		}
	}
	return null;
};

const fetchEmbed = async (
	shortcode: string,
	signal: AbortSignal,
): Promise<Flow<InstagramMedia, ExtractionError>> => {
	const html = await http(
		`https://www.instagram.com/p/${shortcode}/embed/captioned/`,
		{
			headers: HEADERS,
			responseType: "text",
			attempts: 1,
			signal,
		},
	);
	return F.failIfNull(
		extractionError("NO_MEDIA", "no media in embed payload"),
		parseEmbedMedia(html, shortcode),
	);
};

const buildEmbedPlan =
	(url: string) =>
	(media: InstagramMedia): Flow<MediaPlan, ExtractionError> => {
		const plan = buildInstagramMediaPlan(media, HEADERS);
		if (
			/^\/(?:reels?|tv)\//.test(new URL(url).pathname) &&
			plan._tag === "Continue" &&
			plan.value.type === "photo"
		) {
			return F.fail(
				extractionError("NO_MEDIA", "embed returned only a video cover"),
			);
		}
		return plan;
	};

export const embed = defineStrategy(
	"embed",
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
			.pipe((shortcode) => fetchEmbed(shortcode, context.signal))
			.pipe(buildEmbedPlan(url))
			.run(),
);
