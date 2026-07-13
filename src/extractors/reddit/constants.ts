export const HEADERS = {
	Accept: "application/json, text/html;q=0.9, */*;q=0.8",
	"Accept-Language": "en-US,en;q=0.5",
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
};

export const IMAGE_HEADERS = {
	...HEADERS,
	Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
};

export const DOWNLOAD_CONNECTIONS = 6;
export const DOWNLOAD_MIN_BYTES_PER_SECOND = 512 * 1024;
