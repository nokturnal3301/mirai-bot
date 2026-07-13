// Threads serves the full SSR with media URLs only to search-engine crawlers.
// Anonymous browser UAs get a login-walled shell.
export const HEADERS = {
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.5",
	"User-Agent":
		"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
};

export const SCRIPT_PATTERN =
	/<script type="application\/json"[^>]*data-sjs[^>]*>([\s\S]*?)<\/script>/g;
