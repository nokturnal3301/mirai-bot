import type { MediaPlan } from "extractors/media";
import type { ExtractionError, Flow, StrategyContext } from "lib";

import { InstagramMediaInfoSchema } from "extractors/instagram/schemas";
import {
	buildInstagramMediaPlan,
	extractShortcode,
	instagramMediaIdOf,
} from "extractors/instagram/utils";
import { extractionError, F, chain, defineStrategy, http } from "lib";

const MOBILE_HEADERS = {
	Accept: "*/*",
	"Accept-Language": "en-US",
	"User-Agent":
		"Instagram 275.0.0.27.98 Android (33/13; 280dpi; 720x1423; Xiaomi; Redmi 7; en_US)",
	"X-IG-App-ID": "936619743392459",
	"X-IG-App-Locale": "en_US",
	"X-IG-Device-Locale": "en_US",
	"X-IG-Mapped-Locale": "en_US",
};

const fetchMedia = async (
	shortcode: string,
	signal: AbortSignal,
): Promise<Flow<MediaPlan, ExtractionError>> => {
	const mediaId = instagramMediaIdOf(shortcode);
	if (!mediaId) {
		return F.fail(
			extractionError("NOT_APPLICABLE", "invalid Instagram shortcode"),
		);
	}

	const infoRaw = await http<unknown>(
		`https://i.instagram.com/api/v1/media/${mediaId}/info/`,
		{
			headers: MOBILE_HEADERS,
			responseType: "json",
			attempts: 1,
			signal,
		},
	);
	const info = InstagramMediaInfoSchema.safeParse(infoRaw);
	if (!info.success) {
		return F.fail(
			extractionError("SCHEMA_MISMATCH", "Instagram mobile schema mismatch"),
		);
	}
	const media = info.data.items?.[0];
	return media
		? buildInstagramMediaPlan(media, MOBILE_HEADERS)
		: F.fail(extractionError("NO_MEDIA", "no media in mobile response"));
};

export const mobile = defineStrategy(
	"mobile",
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
			.pipe((shortcode) => fetchMedia(shortcode, context.signal))
			.run(),
);
