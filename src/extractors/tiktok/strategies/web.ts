import type { Flow } from "lib/flow";
import type { ExtractionError, StrategyContext } from "lib";
import type { MediaPlan } from "extractors/media";
import { F, chain, defineStrategy, http, logger } from "lib";
import { HEADERS } from "extractors/tiktok/constants";
import {
	buildTikTokMediaPlan,
	parseTikTokItem,
	resolveTikTokTarget,
	type TikTokStrategyInput,
} from "extractors/tiktok/utils";

type PageData = { cookies: string; html: string };

const fetchPage = async (
	pageUrl: string,
	signal: AbortSignal,
): Promise<Flow<PageData, ExtractionError>> => {
	const response = await http(pageUrl, {
		headers: {
			...HEADERS,
			Accept: "text/html",
			"Accept-Language": "en-US,en;q=0.9",
		},
		responseType: "textWithHeaders",
		signal,
	});

	const cookies = response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
	if (!cookies.includes("tt_chain_token")) {
		logger.warn("[tiktok/web] no tt_chain_token in response");
	}

	return F.of({ cookies, html: response.body });
};

const buildMediaPlan = ({
	cookies,
	html,
}: PageData): Flow<MediaPlan, ExtractionError> => {
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
