import { HEADERS } from "extractors/reddit/constants";
import { extractionError, http, logger } from "lib";

const POST_PATTERN = /reddit\.com\/(?:r\/[\w]+\/)?comments\/([\w]+)/;
const SHORT_PATTERN = /redd\.it\/([\w]+)/;
const SHARE_PATTERN = /reddit\.com\/r\/[\w]+\/s\/([\w]+)/;
const VREDD_PATTERN = /v\.redd\.it\/([\w]+)/;
const IREDD_PATTERN = /i\.redd\.it\/([\w]+)\./;

const CHALLENGE_PATTERN = /await\(async e=>e\+e\)\("([a-f0-9]+)"\)/;
const TOKEN_PATTERN = /name="token" value="([a-f0-9]+)"/;
const CHALLENGE_TARGET = "https://www.reddit.com/r/popular/";
const COOKIE_TTL_MS = 30 * 60 * 1000;

type CookieJar = { cookies: string; expiresAt: number };

let jar: CookieJar | null = null;
let pending: Promise<string> | null = null;

const collectCookies = (response: { headers: Headers }): string[] => {
	const set = response.headers.getSetCookie?.() ?? [];
	return set
		.map((c) => c.split(";")[0]?.trim())
		.filter((c): c is string => !!c);
};

const dedupCookies = (raw: string[]): string => {
	const seen = new Map<string, string>();
	for (const c of raw) {
		const [name, ...rest] = c.split("=");
		if (name) seen.set(name, rest.join("="));
	}
	return Array.from(seen, ([k, v]) => `${k}=${v}`).join("; ");
};

const solveChallenge = async (): Promise<string> => {
	logger.info("[reddit] solving js challenge");

	const r1 = await http(CHALLENGE_TARGET, {
		headers: HEADERS,
		responseType: "textWithHeaders",
		proxy: true,
	});

	const html = r1.body;
	const challenge = html.match(CHALLENGE_PATTERN)?.[1];
	const token = html.match(TOKEN_PATTERN)?.[1];

	if (!challenge || !token) {
		throw extractionError(
			"UPSTREAM_REJECTED",
			"no JS challenge in Reddit response",
		);
	}

	const cookies1 = collectCookies(r1);
	const url = `${CHALLENGE_TARGET}?solution=${challenge}${challenge}&js_challenge=1&token=${token}&jsc_orig_r=`;

	const r2 = await http(url, {
		headers: { ...HEADERS, Cookie: dedupCookies(cookies1) },
		responseType: "raw",
		proxy: true,
	});

	const cookies2 = collectCookies(r2);
	const combined = dedupCookies([...cookies1, ...cookies2]);

	logger.info(
		`[reddit] challenge solved (${[...cookies1, ...cookies2].length} cookies)`,
	);

	return combined;
};

export const getRedditCookies = async (): Promise<string> => {
	const now = Date.now();
	if (jar && jar.expiresAt > now) return jar.cookies;
	if (pending) return pending;

	pending = solveChallenge()
		.then((cookies) => {
			jar = { cookies, expiresAt: Date.now() + COOKIE_TTL_MS };
			return cookies;
		})
		.finally(() => {
			pending = null;
		});

	return pending;
};

export const invalidateRedditCookies = (): void => {
	jar = null;
};

export const shredditUrlOf = (postUrl: string): string | null => {
	const parsed = new URL(postUrl);
	const slug = parsed.pathname.replace(/^\/+|\/+$/g, "");
	if (!slug) return null;
	const endpoint = new URL(`https://www.reddit.com/svc/shreddit/${slug}`);
	endpoint.searchParams.set("seeker-session", "false");
	endpoint.searchParams.set("render-mode", "partial");
	endpoint.searchParams.set("referer", postUrl);
	return endpoint.toString();
};

export const refreshRedditSession = async (postUrl: string): Promise<void> => {
	const endpoint = shredditUrlOf(postUrl);
	if (!endpoint) {
		throw extractionError("NOT_APPLICABLE", "no Reddit post slug");
	}

	const cookies = await getRedditCookies();
	const response = await http(endpoint, {
		headers: { ...HEADERS, Cookie: cookies },
		responseType: "raw",
		proxy: true,
	});
	const refreshed = dedupCookies([
		...cookies.split(/;\s*/),
		"over18=1",
		...collectCookies(response),
	]);
	jar = { cookies: refreshed, expiresAt: Date.now() + COOKIE_TTL_MS };
	await response.body?.cancel();
	logger.info("[reddit] anonymous session refreshed via shreddit");
};

export const extractPostId = (url: string): string | null =>
	url.match(POST_PATTERN)?.[1] ?? null;

export const extractShortId = (url: string): string | null =>
	url.match(SHORT_PATTERN)?.[1] ?? null;

export const extractShareId = (url: string): string | null =>
	url.match(SHARE_PATTERN)?.[1] ?? null;

export const extractVReddId = (url: string): string | null =>
	url.match(VREDD_PATTERN)?.[1] ?? null;

export const extractIReddId = (url: string): string | null =>
	url.match(IREDD_PATTERN)?.[1] ?? null;

export const isNativeMediaUrl = (url: string): boolean =>
	/^https?:\/\/(?:i|v)\.redd\.it\//.test(url) ||
	/^https?:\/\/(?:www\.)?reddit\.com\/gallery\//.test(url) ||
	/^https?:\/\/(?:www\.)?reddit\.com\/media\?/.test(url);

export const decodeHtmlEntities = (s: string): string =>
	s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&#39;/g, "'");
