import type { Extractor } from "extractors/types";
import { materializeMedia } from "extractors/media";

import { execute, matchesHttpUrl, sequence } from "lib";
import { image } from "extractors/reddit/strategies/image";
import { json } from "extractors/reddit/strategies/json";
import { vredd } from "extractors/reddit/strategies/vredd";

export const reddit: Extractor = {
	platform: "reddit",
	match: (url) =>
		matchesHttpUrl(
			url,
			["reddit.com"],
			/^\/(?:r\/[\w]+\/)?comments\/[\w]+|^\/r\/[\w]+\/s\/[\w]+/,
		) ||
		matchesHttpUrl(url, ["redd.it", "v.redd.it"], /^\/[\w]+/) ||
		matchesHttpUrl(url, ["i.redd.it"], /^\/[\w]+\./),
	extract: (url) =>
		execute({
			tag: "reddit",
			input: url,
			plan: sequence([
				image.with({ kind: "direct", cost: "cheap" }),
				vredd.with({ kind: "direct", cost: "cheap" }),
				json.with({ kind: "fallback", cost: "normal" }),
			]),
		})
			.pipe(materializeMedia)
			.run(),
};
