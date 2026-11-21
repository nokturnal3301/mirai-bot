// Shared by every platform, so a browser version is bumped in one place.
export const CHROME_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

export const GOOGLEBOT_UA =
	"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

// Instagram and Threads ship the post inside these JSON script tags.
export const SJS_SCRIPT_PATTERN =
	/<script type="application\/json"[^>]*data-sjs[^>]*>([\s\S]*?)<\/script>/g;

export const DOWNLOAD_CONNECTIONS = 8;
// A direct download slower than this gives way to the next source.
export const DOWNLOAD_MIN_BYTES_PER_SECOND = 512 * 1024;
