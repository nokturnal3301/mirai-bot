const TWEET_PATTERN = /(?:twitter|x)\.com\/[\w]+\/status\/(\d+)/;

export const extractTweetId = (url: string): string | null =>
	url.match(TWEET_PATTERN)?.[1] ?? null;

// Deterministic token used by twitter's syndication endpoint.
// Derived from tweet ID — same algorithm as the official web widget.
export const tweetToken = (tweetId: string): string =>
	((Number(tweetId) / 1e15) * Math.PI).toString(6 ** 2).replace(/(0+|\.)/g, "");
