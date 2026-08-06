import type { ExtractionError, Flow } from "lib";
import type { MediaItemPlan, MediaPlan } from "extractors/media";
import type { ThreadsPost } from "extractors/threads/types";

import { extractionError, F, chain, defineStrategy, http, logger } from "lib";
import { HEADERS, SCRIPT_PATTERN } from "extractors/threads/constants";
import { ThreadsPostSchema } from "extractors/threads/schemas";
import { extractPostCode } from "extractors/threads/utils";

const findPostInJson = (
	value: unknown,
	postCode: string,
): ThreadsPost | null => {
	if (value === null || typeof value !== "object") return null;

	if ("code" in value && (value as { code?: unknown }).code === postCode) {
		const parsed = ThreadsPostSchema.safeParse(value);
		if (parsed.success) return parsed.data;
	}

	for (const child of Object.values(value as Record<string, unknown>)) {
		if (typeof child === "object" && child !== null) {
			const found = findPostInJson(child, postCode);
			if (found) return found;
		}
	}
	return null;
};

const resolvePostCode = async (
	url: string,
	signal: AbortSignal,
): Promise<Flow<string, ExtractionError>> => {
	const direct = extractPostCode(url);
	if (direct) return F.of(direct);

	const response = await http(url, {
		headers: HEADERS,
		redirect: "manual",
		responseType: "raw",
		signal,
	});
	const location = response.headers.get("location");
	await response.body?.cancel().catch(() => {});
	return F.failIfNull(
		extractionError("UPSTREAM_REJECTED", "invalid Threads share redirect"),
		location ? extractPostCode(new URL(location, url).toString()) : null,
	);
};

const fetchPost = async (
	postCode: string,
): Promise<Flow<ThreadsPost, ExtractionError>> => {
	const pageUrl = `https://www.threads.com/t/${postCode}`;

	const html = await http(pageUrl, { headers: HEADERS, responseType: "text" });

	for (const match of html.matchAll(SCRIPT_PATTERN)) {
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
				kind: "download",
				url: videoUrl,
				headers: HEADERS,
				attempts: 2,
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
	const quoted = post.text_post_app_info?.share_info?.quoted_attachment_post;
	return (quoted as ThreadsPost) ?? post;
};

const buildPlan = (post: ThreadsPost): Flow<MediaPlan, ExtractionError> => {
	const caption = {
		source: "threads" as const,
		author: post.user?.username ?? undefined,
		text: post.caption?.text ?? undefined,
	};

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

	if (item.type === "video") {
		return F.of({
			type: "video",
			source: item.source,
			width: item.width,
			height: item.height,
			duration,
			caption,
		});
	}

	return F.of({
		type: "photo",
		source: item.source,
		width: item.width,
		height: item.height,
		caption,
	});
};

export const ssr = defineStrategy(
	"ssr",
	(url: string, context): Promise<Flow<MediaPlan, ExtractionError>> =>
		chain(F.of(url))
			.pipe((url) => resolvePostCode(url, context.signal))
			.pipe(fetchPost)
			.pipe(buildPlan)
			.run(),
);
