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

export type Media =
	| {
			type: "video";
			data: Blob | string | RemoteMediaResource;
			width?: number;
			height?: number;
			duration?: number;
			caption?: Caption;
	  }
	| {
			type: "photo";
			data: Blob | string;
			width?: number;
			height?: number;
			caption?: Caption;
	  }
	| {
			type: "audio";
			data: Blob | string;
			duration?: number;
			title?: string;
			performer?: string;
	  }
	| {
			type: "carousel";
			items: MediaItem[];
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
