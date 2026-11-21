import type { Flow } from "lib/flow";
import type { ExtractionError, StrategyContext } from "lib";
import type { MediaPlan } from "extractors/media";
import { F, chain, defineStrategy, logger } from "lib";
import {
	buildTikTokMediaPlan,
	fetchTikTokPage,
	parseTikTokItem,
	resolveTikTokTarget,
	type TikTokPage,
	type TikTokStrategyInput,
} from "extractors/tiktok/utils";

const fetchPage = async (
	pageUrl: string,
	signal: AbortSignal,
): Promise<Flow<TikTokPage, ExtractionError>> => {
	const page = await fetchTikTokPage(pageUrl, signal, {
		"Accept-Language": "en-US,en;q=0.9",
	});
	if (!page.cookies.includes("tt_chain_token")) {
		logger.warn("[tiktok/web] no tt_chain_token in response");
	}

	return F.of(page);
};

const buildMediaPlan = ({
	cookies,
	html,
}: TikTokPage): Flow<MediaPlan, ExtractionError> => {
	const item = parseTikTokItem(html);
	return item._tag === "Continue"
		? buildTikTokMediaPlan(item.value, cookies, "page")
		: item;
};

export const web = defineStrategy(
	"web",
	async (
		input: TikTokStrategyInput,
		context: StrategyContext,
	): Promise<Flow<MediaPlan, ExtractionError>> => {
		const target = await resolveTikTokTarget(input, context);
		return chain(F.of(target.pageUrl))
			.pipe((pageUrl) => fetchPage(pageUrl, context.signal))
			.pipe(buildMediaPlan)
			.run();
	},
);
