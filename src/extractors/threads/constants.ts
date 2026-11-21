import { GOOGLEBOT_UA } from "extractors/constants";

// Threads serves the full SSR with media URLs only to search-engine crawlers.
// Anonymous browser UAs get a login-walled shell.
export const HEADERS = {
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.5",
	"User-Agent": GOOGLEBOT_UA,
};
