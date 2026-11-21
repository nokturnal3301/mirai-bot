import { CHROME_UA } from "extractors/constants";

export const HEADERS = {
	Accept: "application/json, text/html;q=0.9, */*;q=0.8",
	"Accept-Language": "en-US,en;q=0.5",
	"User-Agent": CHROME_UA,
};

export const IMAGE_HEADERS = {
	...HEADERS,
	Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
};

export const DOWNLOAD_CONNECTIONS = 6;
