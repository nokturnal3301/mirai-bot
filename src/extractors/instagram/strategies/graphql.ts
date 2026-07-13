import type { MediaPlan } from "extractors/media";
import type { ExtractionError, Flow, StrategyContext } from "lib";

import { HEADERS } from "extractors/instagram/constants";
import {
	buildInstagramMediaPlan,
	extractShortcode,
	findInstagramGraphMedia,
	findInstagramMedia,
	instagramMediaIdOf,
} from "extractors/instagram/utils";
import { extractionError, F, chain, defineStrategy, http } from "lib";

const APP_ID = "936619743392459";
const QUERY_NAME = "PolarisLoggedOutDesktopWWWPostRootContentQuery";
const DOC_ID = "27130156389949648";

const tokenOf = (html: string): string | null =>
	html.match(/\["LSD",\[\],\{"token":"([^"]+)"/)?.[1] ??
	html.match(/"lsd":"([^"]+)"/)?.[1] ??
	null;

const csrfOf = (html: string): string | null =>
	html.match(/"csrf_token":"([^"]+)"/)?.[1] ?? null;

const jazoestOf = (token: string): string =>
	`2${[...token].reduce((sum, char) => sum + char.charCodeAt(0), 0)}`;

const fetchGraphql = async (
	shortcode: string,
	signal: AbortSignal,
): Promise<Flow<MediaPlan, ExtractionError>> => {
	const html = await http(`https://www.instagram.com/p/${shortcode}/`, {
		headers: HEADERS,
		responseType: "text",
		attempts: 1,
		signal,
	});
	const lsd = tokenOf(html);
	if (!lsd) {
		return F.fail(
			extractionError("UPSTREAM_REJECTED", "no Instagram LSD token"),
		);
	}
	const mediaId = instagramMediaIdOf(shortcode);
	if (!mediaId) {
		return F.fail(
			extractionError("NOT_APPLICABLE", "invalid Instagram shortcode"),
		);
	}
	const csrf = csrfOf(html);

	const body = new URLSearchParams({
		av: "0",
		__d: "www",
		__user: "0",
		__a: "1",
		__req: "1",
		__ccg: "EXCELLENT",
		dpr: "1",
		lsd,
		jazoest: jazoestOf(lsd),
		fb_api_caller_class: "RelayModern",
		fb_api_req_friendly_name: QUERY_NAME,
		variables: JSON.stringify({ media_id: mediaId }),
		server_timestamps: "true",
		doc_id: DOC_ID,
	});
	const raw = await http<unknown>("https://www.instagram.com/api/graphql", {
		method: "POST",
		headers: {
			...HEADERS,
			"Content-Type": "application/x-www-form-urlencoded",
			"X-ASBD-ID": "129477",
			"X-FB-Friendly-Name": QUERY_NAME,
			"X-FB-LSD": lsd,
			"X-IG-App-ID": APP_ID,
			...(csrf ? { "X-CSRFToken": csrf, Cookie: `csrftoken=${csrf}` } : {}),
		},
		body,
		responseType: "json",
		attempts: 1,
		signal,
	});
	const media =
		findInstagramMedia(raw, shortcode) ??
		findInstagramGraphMedia(raw, shortcode);
	return media
		? buildInstagramMediaPlan(media, HEADERS)
		: F.fail(extractionError("NO_MEDIA", "no media in GraphQL response"));
};

export const graphql = defineStrategy(
	"graphql",
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
			.pipe((shortcode) => fetchGraphql(shortcode, context.signal))
			.run(),
);
