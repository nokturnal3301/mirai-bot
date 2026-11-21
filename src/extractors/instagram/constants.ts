import { CHROME_UA, GOOGLEBOT_UA } from "extractors/constants";

export const HEADERS = {
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.5",
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"User-Agent": CHROME_UA,
};

export const CRAWLER_HEADERS = {
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.5",
	"User-Agent": GOOGLEBOT_UA,
};
