import type { Flow } from "lib/flow";
import type { ExtractionError } from "lib/errors";

export type Platform =
	| "instagram"
	| "youtube"
	| "tiktok"
	| "threads"
	| "twitter"
	| "reddit";

export type MediaItem = {
	type: "photo" | "video";
	data: Blob | string;
	width?: number;
	height?: number;
	duration?: number;
};

export type Caption = {
	source?: Platform;
	// Handle without "@"; rendered as u/name on Reddit.
	author?: string;
	// Display name, or the channel name on YouTube.
	name?: string;
	verified?: boolean;
	text?: string;
	// Reddit post title and flair, shown above the media.
	title?: string;
	flair?: string;
	// Subreddit without "r/".
	community?: string;
	stats?: {
		views?: number;
		likes?: number;
		comments?: number;
		score?: number;
	};
	// Unix seconds.
	postedAt?: number;
	// "Song — Artist".
	music?: string;
	// Handle the post replies to.
	replyTo?: string;
	quote?: { author?: string; text: string };
	// NSFW or spoiler: media is sent blurred.
	sensitive?: boolean;
};

export type DashVideo = {
	url: string;
	width: number;
	height: number;
	bandwidth: number;
	codecs: string;
};

export type DashManifest = { audioUrl?: string; videos: DashVideo[] };

export type RemoteMediaResource = {
	kind: "remote";
	url: string;
	headers?: Record<string, string>;
	size?: number;
	telegramFetch?: boolean;
	connections?: number;
	httpContext?: {
		forceProxy: boolean;
		proxySession?: string;
		proxyCountry?: string;
	};
};

// A file Telegram already stores, replayed from the cache by its id.
export type TelegramFile = { kind: "telegram"; fileId: string };

// A string is always a URL that Telegram downloads itself.
export type Media =
	| {
			type: "video";
			data: Blob | string | RemoteMediaResource | TelegramFile;
			width?: number;
			height?: number;
			duration?: number;
			caption?: Caption;
	  }
	| {
			type: "photo";
			data: Blob | string | TelegramFile;
			width?: number;
			height?: number;
			caption?: Caption;
	  }
	| {
			type: "audio";
			data: Blob | string | TelegramFile;
			duration?: number;
			title?: string;
			performer?: string;
	  }
	| {
			type: "carousel";
			items: MediaItem[];
			// Items in the original post, set when some could not be included.
			total?: number;
			caption?: Caption;
			audio?: {
				data: Blob | string;
				duration?: number;
				title?: string;
				performer?: string;
			};
	  }
	| { type: "text"; caption: Caption };

export type Extractor = {
	platform: Platform;
	match: (url: string) => boolean;
	extract: (url: string) => Promise<Flow<Media, ExtractionError>>;
	// Per-process setup done at boot so the first request doesn't pay for it.
	warm?: () => Promise<void>;
};
