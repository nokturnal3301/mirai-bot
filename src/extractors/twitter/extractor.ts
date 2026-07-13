import type { Extractor } from "extractors/types";
import { materializeMedia } from "extractors/media";

import { execute, matchesHttpUrl, sequence } from "lib";
import { syndication } from "extractors/twitter/strategies/syndication";

export const twitter: Extractor = {
	platform: "twitter",
	match: (url) =>
		matchesHttpUrl(url, ["twitter.com", "x.com"], /^\/[\w]+\/status\/\d+/),
	extract: (url) =>
		execute({
			tag: "twitter",
			input: url,
			plan: sequence([syndication.with({ kind: "metadata", cost: "cheap" })]),
		})
			.pipe(materializeMedia)
			.run(),
};
