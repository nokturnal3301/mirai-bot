import type { Extractor } from "extractors/types";
import { materializeMedia } from "extractors/media";
import { adaptiveDelay, execute, hedge, matchesHttpUrl } from "lib";
import { SSR_HEDGE_DELAY_MS } from "extractors/tiktok/constants";
import { ssr } from "extractors/tiktok/strategies/ssr";
import { web } from "extractors/tiktok/strategies/web";

export const tiktok: Extractor = {
	platform: "tiktok",
	match: (url) =>
		matchesHttpUrl(
			url,
			["tiktok.com"],
			/^\/(?:@[^/]+\/(?:video|photo)\/\d+|[\w-]+\/?$)/,
		),
	extract: (url) =>
		execute({
			tag: "tiktok",
			input: { url },
			plan: hedge([
				web.with({ kind: "direct", cost: "cheap" }),
				ssr.with({
					kind: "fallback",
					cost: "expensive",
					after: adaptiveDelay("web", {
						fallback: SSR_HEDGE_DELAY_MS,
						min: 100,
						max: 600,
					}),
					circuitBreaker: { failures: 3, resetAfter: 30_000 },
				}),
			]),
		})
			.pipe(materializeMedia)
			.run(),
};
