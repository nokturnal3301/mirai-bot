import type { Flow } from "lib/flow";
import type { ExtractionError, StrategyContext } from "lib";
import type { MediaPlan } from "extractors/media";
import { F, chain, defineStrategy, http, logger } from "lib";
import { HEADERS } from "extractors/tiktok/constants";
import type { SSRItem } from "extractors/tiktok/schemas";
import {
	buildTikTokMediaPlan,
	hasTikTokSsrData,
	parseTikTokItem,
	resolveTikTokTarget,
	solveChallenge,
	type TikTokStrategyInput,
} from "extractors/tiktok/utils";

const REGION_COOKIE = "tt-target-idc=useast2a";
type PageResult = { html: string; cookies: string };
type ItemPayload = { item: SSRItem; cookies: string };

const fetchPage = async (
	pageUrl: string,
	signal: AbortSignal,
	extraHeaders: Record<string, string> = {},
): Promise<PageResult> => {
	const response = await http(pageUrl, {
		headers: { ...HEADERS, Accept: "text/html", ...extraHeaders },
		responseType: "textWithHeaders",
		signal,
	});
	const cookies = response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
	return { html: response.body, cookies };
};

const fetchItem = async (
	postId: string,
	signal: AbortSignal,
): Promise<Flow<ItemPayload, ExtractionError>> => {
	const pageUrl = `https://www.tiktok.com/@i/video/${postId}`;
	let page = await fetchPage(pageUrl, signal, { Cookie: REGION_COOKIE });

	if (!hasTikTokSsrData(page.html)) {
		const challengeCookie = await solveChallenge(page.html, signal);
		if (challengeCookie) {
			page = await fetchPage(pageUrl, signal, {
				Cookie: `${REGION_COOKIE}; ${challengeCookie}`,
			});
		} else {
			logger.warn("[tiktok/ssr] no SSR data, challenge solve failed");
		}
	}

	const item = parseTikTokItem(page.html);
	if (item._tag !== "Continue") {
		logger.warn(
			`[tiktok/ssr] ${item._tag === "Fail" ? item.error.message : "stopped"}`,
		);
		return item;
	}
	return F.of({ item: item.value, cookies: page.cookies });
};

const buildMediaPlan = ({
	item,
	cookies,
}: ItemPayload): Flow<MediaPlan, ExtractionError> =>
	buildTikTokMediaPlan(item, cookies, "challenge");

export const ssr = defineStrategy(
	"ssr",
	async (
		input: TikTokStrategyInput,
		context: StrategyContext,
	): Promise<Flow<MediaPlan, ExtractionError>> => {
		const target = await resolveTikTokTarget(input, context);
		return chain(F.of(target.postId))
			.pipe((postId) => fetchItem(postId, context.signal))
			.pipe(buildMediaPlan)
			.run();
	},
);
