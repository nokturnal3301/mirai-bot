import type { Caption } from "extractors/types";
import type { ThreadsPost } from "extractors/threads/types";

const POST_PATTERN = /threads\.(?:com|net)\/@[\w.-]+\/post\/([\w-]+)/;

export const extractPostCode = (url: string): string | null =>
	url.match(POST_PATTERN)?.[1] ?? null;

export const postCaption = (post: ThreadsPost): Caption => {
	const info = post.text_post_app_info;
	const quoted = info?.share_info?.quoted_post;
	const quoteText = quoted?.caption?.text?.trim();
	const countsHidden = post.like_and_view_counts_disabled === true;
	return {
		source: "threads",
		author: post.user?.username ?? undefined,
		name: post.user?.full_name || undefined,
		verified: post.user?.is_verified || undefined,
		text: post.caption?.text ?? undefined,
		stats: {
			likes: countsHidden ? undefined : (post.like_count ?? undefined),
			comments: info?.direct_reply_count ?? undefined,
		},
		postedAt: post.taken_at ?? undefined,
		quote: quoteText
			? { author: quoted?.user?.username ?? undefined, text: quoteText }
			: undefined,
		sensitive: info?.is_spoiler_media || undefined,
	};
};
