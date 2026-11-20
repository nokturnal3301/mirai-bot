import type { Caption } from "extractors/types";
import { decodeHtmlEntities } from "lib";
import type { SyndicationTweet } from "extractors/twitter/types";

const TWEET_PATTERN = /(?:twitter|x)\.com\/[\w]+\/status\/(\d+)/;

export const extractTweetId = (url: string): string | null =>
	url.match(TWEET_PATTERN)?.[1] ?? null;

// Deterministic token used by twitter's syndication endpoint.
// Derived from tweet ID — same algorithm as the official web widget.
export const tweetToken = (tweetId: string): string =>
	((Number(tweetId) / 1e15) * Math.PI).toString(6 ** 2).replace(/(0+|\.)/g, "");

// Syndication text is HTML-escaped, and display_text_range indexes that escaped
// UTF-16 text: it drops leading reply mentions and the trailing media link.
export const tweetText = (
	tweet: Pick<SyndicationTweet, "text" | "display_text_range" | "entities">,
): string | undefined => {
	if (!tweet.text) return undefined;
	const [start = 0, end = tweet.text.length] = tweet.display_text_range ?? [];
	const visible = (tweet.entities?.urls ?? []).reduce(
		(text, link) =>
			link.expanded_url ? text.replaceAll(link.url, link.expanded_url) : text,
		tweet.text.slice(start, end),
	);
	const decoded = decodeHtmlEntities(visible).trim();
	return decoded || undefined;
};

const unixSeconds = (date: string | undefined): number | undefined => {
	const ms = date ? Date.parse(date) : Number.NaN;
	return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
};

export const tweetCaption = (tweet: SyndicationTweet): Caption => {
	const author = tweet.user?.screen_name;
	const text = tweetText(tweet);
	const quoteText = tweet.quoted_tweet && tweetText(tweet.quoted_tweet);
	const replyTo = tweet.in_reply_to_screen_name;
	return {
		source: "twitter",
		author,
		name: tweet.user?.name,
		verified: tweet.user?.is_blue_verified || tweet.user?.verified || undefined,
		// Long tweets are cut in syndication; the rest lives in note_tweet.
		text: text && tweet.note_tweet ? `${text}…` : text,
		stats: {
			likes: tweet.favorite_count,
			comments: tweet.conversation_count,
		},
		postedAt: unixSeconds(tweet.created_at),
		// A reply to yourself is a thread, not a conversation.
		...(replyTo && replyTo !== author ? { replyTo } : {}),
		...(quoteText
			? {
					quote: {
						author: tweet.quoted_tweet?.user?.screen_name,
						text: quoteText,
					},
				}
			: {}),
		...(tweet.possibly_sensitive ? { sensitive: true } : {}),
	};
};
