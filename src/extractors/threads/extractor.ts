import type { Extractor } from "extractors/types";
import { materializeMedia } from "extractors/media";

import { execute, matchesHttpUrl, sequence } from "lib";
import { ssr } from "extractors/threads/strategies/ssr";

export const threads: Extractor = {
	platform: "threads",
	match: (url) =>
		matchesHttpUrl(
			url,
			["threads.com", "threads.net"],
			/^\/@[\w.-]+\/post\/[\w-]+/,
		),
	extract: (url) =>
		execute({
			tag: "threads",
			input: url,
			plan: sequence([ssr.with({ kind: "metadata", cost: "normal" })]),
		})
			.pipe(materializeMedia)
			.run(),
};
