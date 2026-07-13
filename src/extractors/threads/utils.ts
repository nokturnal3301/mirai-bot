const POST_PATTERN = /threads\.(?:com|net)\/@[\w.-]+\/post\/([\w-]+)/;

export const extractPostCode = (url: string): string | null =>
	url.match(POST_PATTERN)?.[1] ?? null;
