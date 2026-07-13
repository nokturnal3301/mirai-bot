export const HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
};

export const POST_URL_PATTERN = /tiktok\.com\/@[^/]+\/(?:video|photo)\/(\d+)/;
export const SHORT_URL_PATTERN = /(?:vm|vt)\.tiktok\.com/;
export const POST_ID_PATTERN = /(?:video|photo)\/(\d+)/;
export const SSR_HEDGE_DELAY_MS = 250;
export const DOWNLOAD_CONNECTIONS = 6;
export const DOWNLOAD_MIN_BYTES_PER_SECOND = 512 * 1024;
