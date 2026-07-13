const PRIVATE_HOST_PATTERNS = [
	/^localhost$/i,
	/^127\./,
	/^10\./,
	/^192\.168\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^169\.254\./,
	/^0\.0\.0\.0$/,
	/^\[?::\]?$/,
	/^\[?::1\]?$/,
	/^\[?::ffff:/i,
	/^\[?f[cd][0-9a-f]{2}:/i,
	/^\[?fe[89ab][0-9a-f]:/i,
];

const normalizeHostname = (hostname: string): string =>
	hostname.toLowerCase().replace(/\.$/, "");

const parseHttpUrl = (value: string): URL | null => {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:"
			? parsed
			: null;
	} catch {
		return null;
	}
};

export const matchesHttpUrl = (
	value: string,
	domains: readonly string[],
	path: RegExp,
): boolean => {
	const parsed = parseHttpUrl(value);
	if (!parsed) return false;

	const hostname = normalizeHostname(parsed.hostname);
	const matchesDomain = domains.some(
		(domain) => hostname === domain || hostname.endsWith(`.${domain}`),
	);
	return matchesDomain && path.test(parsed.pathname);
};

export const findUrl = (text: string): string | null => {
	const match = text.match(/https?:\/\/[^\s]+/);
	if (!match?.[0]) return null;
	return match[0].replace(/[),.!?;:'"»\]]+$/, "");
};

export const isPublicHttpUrl = (value: string): boolean => {
	const parsed = parseHttpUrl(value);
	if (!parsed) return false;
	const host = normalizeHostname(parsed.hostname);
	return !PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host));
};

export const assertPublicHttpUrl = (value: string): void => {
	if (!isPublicHttpUrl(value)) {
		throw new Error(`unsafe URL: ${value}`);
	}
};
