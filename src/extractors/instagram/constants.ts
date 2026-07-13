export const HEADERS = {
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.5",
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
};

export const CRAWLER_HEADERS = {
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.5",
	"User-Agent":
		"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
};

export const SCRIPT_PATTERN =
	/<script type="application\/json"[^>]*data-sjs[^>]*>([\s\S]*?)<\/script>/g;

export const DOWNLOAD_CONNECTIONS = 8;
export const DOWNLOAD_MIN_BYTES_PER_SECOND = 512 * 1024;
