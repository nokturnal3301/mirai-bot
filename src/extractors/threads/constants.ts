// Threads serves the full SSR with media URLs only to search-engine crawlers.
// Anonymous browser UAs get a login-walled shell.
export const HEADERS = {
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.5",
	"User-Agent":
		"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
};

// Same CDN as Instagram, which serves it fastest over parallel ranges.
export const DOWNLOAD_CONNECTIONS = 8;
export const DOWNLOAD_MIN_BYTES_PER_SECOND = 512 * 1024;

export const SCRIPT_PATTERN =
	/<script type="application\/json"[^>]*data-sjs[^>]*>([\s\S]*?)<\/script>/g;
