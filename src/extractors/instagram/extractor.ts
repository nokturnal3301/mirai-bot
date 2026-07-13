import type { Extractor } from "extractors/types";
import { materializeMedia } from "extractors/media";

import { adaptiveDelay, execute, hedge, matchesHttpUrl } from "lib";
import { embed } from "extractors/instagram/strategies/embed";
import { graphql } from "extractors/instagram/strategies/graphql";
import { mobile } from "extractors/instagram/strategies/mobile";
import { ssr } from "extractors/instagram/strategies/ssr";

export const instagram: Extractor = {
	platform: "instagram",
	match: (url) =>
		matchesHttpUrl(url, ["instagram.com"], /^\/(?:reel|reels|p|tv)\/[\w-]+/),
	extract: (url) =>
		execute({
			tag: "instagram",
			input: url,
			plan: hedge([
				embed.with({ kind: "metadata", cost: "cheap" }),
				ssr.with({
					kind: "metadata",
					cost: "normal",
					after: adaptiveDelay("embed", {
						fallback: 120,
						min: 60,
						max: 350,
					}),
					circuitBreaker: { failures: 3, resetAfter: 60_000 },
				}),
				mobile.with({
					kind: "fallback",
					cost: "normal",
					after: 1_500,
					afterFailureOf: ["embed", "ssr"],
					circuitBreaker: { failures: 3, resetAfter: 60_000 },
				}),
				graphql.with({
					kind: "fallback",
					cost: "expensive",
					after: 2_500,
					afterFailureOf: ["embed", "ssr", "mobile"],
					circuitBreaker: { failures: 2, resetAfter: 60_000 },
				}),
			]),
		})
			.pipe(materializeMedia)
			.run(),
};
