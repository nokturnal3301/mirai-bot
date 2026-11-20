import type { Extractor, Media } from "extractors/types";
import { materializeMedia, type MediaPlan } from "extractors/media";
import {
	F,
	chain,
	execute,
	matchesHttpUrl,
	retry,
	sequence,
	withStickyProxy,
	type Strategy,
} from "lib";
import { adaptive } from "extractors/youtube/strategies/adaptive";
import { combined } from "extractors/youtube/strategies/combined";
import { prefetchEngagement } from "extractors/youtube/utils";
import { SESSION_ROLLS } from "./constants";

const withDownload = (
	strategy: Strategy<string, MediaPlan>,
): Strategy<string, Media> =>
	Object.freeze({
		...strategy,
		execute: (url, context) =>
			chain(strategy.execute(url, context))
				.pipe((plan) => materializeMedia(plan, context.signal))
				.run(),
	});

export const youtube: Extractor = {
	platform: "youtube",
	match: (url) => matchesHttpUrl(url, ["youtube.com"], /^\/shorts\/[\w-]+/),
	extract: async (url) => {
		const withEngagement = prefetchEngagement(url);
		const result = await retry("youtube", SESSION_ROLLS, () =>
			withStickyProxy(() =>
				execute({
					tag: "youtube",
					input: url,
					plan: sequence([
						withDownload(combined.with({ kind: "direct", cost: "cheap" })),
						withDownload(
							adaptive.with({ kind: "fallback", cost: "expensive" }),
						),
					]),
				}).run(),
			),
		);
		return result._tag === "Continue"
			? F.of(await withEngagement(result.value))
			: result;
	},
};
