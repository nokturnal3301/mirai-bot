export const MESSAGES = {
	WELCOME: `Hey there! I'm Mirai, the media downloader. Send me a link from Instagram, TikTok, YouTube, Threads, Twitter/X, or Reddit — I'll grab the content for you!`,
	HELP: `Need a hand? No problem!
	Just paste a link from:
	• Instagram (reels, posts, carousels)
	• TikTok (videos, photo slideshows)
	• YouTube (shorts)
	• Threads (posts, photos, carousels)
	• Twitter / X (tweets, photos, videos)
	• Reddit (images, galleries, native videos)
	I'll do my best to get that for you!`,
} as const;

import type { Platform } from "extractors/types";

// Matching platform logos from https://t.me/addemoji/app_set.
// IDs and artwork verified with getStickerSet; keep IDs as strings.
export const SOURCE_ICONS: Record<Platform, string> = {
	instagram: "5280708542934833772",
	tiktok: "5249421449940196012",
	youtube: "5248965805449700363",
	threads: "5246853643612740845",
	twitter: "5244967186602157741",
	reddit: "5307693040771559084",
};

export const AUDIO_EXT: Record<string, string> = {
	"audio/mpeg": "mp3",
	"audio/mp3": "mp3",
	"audio/mp4": "m4a",
	"audio/aac": "aac",
	"audio/ogg": "ogg",
	"audio/opus": "opus",
	"audio/wav": "wav",
	"audio/webm": "webm",
};

export const ERRORS = {
	EXTRACTION_FAILED:
		"Couldn't grab this one — the post might be private, deleted, or geo-restricted.",
	FILE_TOO_LARGE:
		"This media is too large for Telegram (max 50MB). Try a shorter one?",
	RATE_LIMITED: "Slow down a bit — too many requests. Try again in a minute.",
	UNKNOWN: "Something went wrong. Please try again later.",
} as const;

export type ErrorCode = keyof typeof ERRORS;
