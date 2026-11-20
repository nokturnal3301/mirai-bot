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

export type CardIcon = { id: string; alt: string };

// Our adaptive set https://t.me/addemoji/mirai_icons_by_mirai_downloader_bot:
// clients repaint the icons in the text color. IDs verified with getStickerSet.
export const SOURCE_ICONS: Record<Platform, CardIcon> = {
	instagram: { id: "5190449148079419229", alt: "📷" },
	tiktok: { id: "5190599579308960987", alt: "🎶" },
	youtube: { id: "5188324277434229174", alt: "▶️" },
	threads: { id: "5188635267426200843", alt: "🧵" },
	twitter: { id: "5188444777036689824", alt: "✖️" },
	reddit: { id: "5188148531667446459", alt: "🤖" },
};

export const CARD_ICONS = {
	views: { id: "5188343871075037812", alt: "👁" },
	likes: { id: "5188357597790513999", alt: "❤️" },
	comments: { id: "5190723862777604934", alt: "💬" },
	music: { id: "5188676559241786036", alt: "🎵" },
	score: { id: "5188460908933853761", alt: "⬆️" },
	reply: { id: "5190681634659151988", alt: "↩️" },
} as const satisfies Record<string, CardIcon>;

// Reddit has no hashtags.
export const HASHTAG_URLS: Partial<Record<Platform, (tag: string) => string>> =
	{
		instagram: (tag) => `https://www.instagram.com/explore/tags/${tag}/`,
		tiktok: (tag) => `https://www.tiktok.com/tag/${tag}`,
		youtube: (tag) => `https://www.youtube.com/hashtag/${tag}`,
		threads: (tag) =>
			`https://www.threads.com/search?q=%23${tag}&serp_type=tags`,
		twitter: (tag) => `https://x.com/hashtag/${tag}`,
	};

export const PROFILE_URLS: Record<Platform, (handle: string) => string> = {
	instagram: (handle) => `https://www.instagram.com/${handle}/`,
	tiktok: (handle) => `https://www.tiktok.com/@${handle}`,
	youtube: (handle) => `https://www.youtube.com/@${handle}`,
	threads: (handle) => `https://www.threads.com/@${handle}`,
	twitter: (handle) => `https://x.com/${handle}`,
	reddit: (handle) => `https://www.reddit.com/user/${handle}/`,
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
