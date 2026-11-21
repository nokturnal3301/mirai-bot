import type { ExtractionError, Flow } from "lib";
import type { ThreadsPost } from "extractors/threads/types";

import { extractionError, F, chain, defineStrategy, http, logger } from "lib";
import { DOWNLOAD_CONNECTIONS, SJS_SCRIPT_PATTERN } from "extractors/constants";
import {
	directThenProxy,
	planOfItem,
	type MediaItemPlan,
	type MediaPlan,
} from "extractors/media";
import { findDeep } from "extractors/utils";
import { HEADERS } from "extractors/threads/constants";
import { ThreadsPostSchema } from "extractors/threads/schemas";
import { extractPostCode, postCaption } from "extractors/threads/utils";

const findPostInJson = (value: unknown, postCode: string): ThreadsPost | null =>
	findDeep(value, (node) =>
		"code" in node && node.code === postCode
			? (ThreadsPostSchema.safeParse(node).data ?? null)
			: null,
	);

// Share links redirect straight to the post page, so one request follows them
// instead of resolving the code first and loading /t/<code>, which redirects too.
const fetchPost = async (
	url: string,
	signal: AbortSignal,
): Promise<Flow<ThreadsPost, ExtractionError>> => {
	const page = await http(url, {
		headers: HEADERS,
		responseType: "textWithHeaders",
		signal,
	});
	const postCode = extractPostCode(url) ?? extractPostCode(page.url);
	if (!postCode) {
		return F.fail(
			extractionError("UPSTREAM_REJECTED", "invalid Threads share redirect"),
		);
	}
	const html = page.body;

	for (const match of html.matchAll(SJS_SCRIPT_PATTERN)) {
		const raw = match[1];
		if (!raw || !raw.includes(`"code":"${postCode}"`)) continue;

		try {
			const parsed = JSON.parse(raw);
			const found = findPostInJson(parsed, postCode);
			if (found) return F.of(found);
		} catch {
			// try next script tag
		}
	}

	logger.warn("[threads/ssr] could not locate post data");
	return F.fail(extractionError("NO_MEDIA", "Threads post data not found"));
};

const itemPlanOf = (
	source: ThreadsPost | NonNullable<ThreadsPost["carousel_media"]>[number],
): MediaItemPlan | null => {
	const videoUrl = source.video_versions?.[0]?.url;
	const width = source.original_width ?? undefined;
	const height = source.original_height ?? undefined;

	if (videoUrl) {
		return {
			type: "video",
			source: {
				kind: "fallback",
				sources: directThenProxy({
					kind: "download",
					url: videoUrl,
					headers: HEADERS,
					attempts: 2,
					connections: DOWNLOAD_CONNECTIONS,
				}),
			},
			width,
			height,
		};
	}

	const candidates = source.image_versions2?.candidates ?? [];
	const best = [...candidates].sort(
		(a, b) =>
			(b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0),
	)[0];
	if (!best?.url) return null;

	return {
		type: "photo",
		source: {
			kind: "download",
			url: best.url,
			headers: HEADERS,
			attempts: 2,
			httpContext: { forceProxy: false },
		},
		width: best.width ?? width ?? undefined,
		height: best.height ?? height ?? undefined,
	};
};

const mediaSource = (post: ThreadsPost): ThreadsPost => {
	const hasMedia =
		!!post.carousel_media?.length ||
		!!post.video_versions?.length ||
		!!post.image_versions2?.candidates?.length;
	if (hasMedia) return post;
	const embedded =
		post.text_post_app_info?.linked_inline_media ??
		post.text_post_app_info?.share_info?.quoted_attachment_post;
	return (embedded as ThreadsPost) ?? post;
};

const buildPlan = (post: ThreadsPost): Flow<MediaPlan, ExtractionError> => {
	const caption = postCaption(post);

	const source = mediaSource(post);

	if (source.carousel_media?.length) {
		const items = source.carousel_media
			.map(itemPlanOf)
			.filter((item): item is MediaItemPlan => item !== null);
		if (items.length === 0) {
			return F.fail(extractionError("NO_MEDIA", "no carousel media URLs"));
		}
		return F.of({ type: "carousel", items, caption });
	}

	const item = itemPlanOf(source);
	if (!item) {
		if (caption.text) return F.of({ type: "text", caption });
		return F.fail(extractionError("NO_MEDIA", "no Threads media URL"));
	}

	const duration = source.video_duration
		? Math.round(source.video_duration)
		: undefined;

	return F.of(
		planOfItem(item.type === "video" ? { ...item, duration } : item, caption),
	);
};

export const ssr = defineStrategy(
	"ssr",
	(url: string, context): Promise<Flow<MediaPlan, ExtractionError>> =>
		chain(F.of(url))
			.pipe((url) => fetchPost(url, context.signal))
			.pipe(buildPlan)
			.run(),
);
