import type { Extractor } from "extractors/types";
import { materializeMedia } from "extractors/media";
import { execute, matchesHttpUrl, retry, sequence, withStickyProxy } from "lib";
import { adaptive } from "extractors/youtube/strategies/adaptive";
import { combined } from "extractors/youtube/strategies/combined";
import { SESSION_ROLLS } from "./constants";

export const youtube: Extractor = {
	platform: "youtube",
	match: (url) => matchesHttpUrl(url, ["youtube.com"], /^\/shorts\/[\w-]+/),
	extract: (url) =>
		retry("youtube", SESSION_ROLLS, () =>
			withStickyProxy(() =>
				execute({
					tag: "youtube",
					input: url,
					plan: sequence([
						combined.with({ kind: "direct", cost: "cheap" }),
						adaptive.with({ kind: "fallback", cost: "expensive" }),
					]),
				})
					.pipe(materializeMedia)
					.run(),
			),
		),
};
