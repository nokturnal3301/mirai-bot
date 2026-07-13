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
	author?: string;
	text?: string;
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
};
