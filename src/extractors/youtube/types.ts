import type { z } from "zod";
import type {
	FormatSchema,
	InnertubeResponseSchema,
} from "extractors/youtube/schemas";

export type InnertubeFormat = z.infer<typeof FormatSchema>;
export type InnertubeResponse = z.infer<typeof InnertubeResponseSchema>;

type InnertubeClientTag = {
	name: string;
	userAgent: string;
};

export type InnertubeResult = {
	data: InnertubeResponse;
	client: InnertubeClientTag;
};

// A client's final "no": only signing in would change it.
export type Refusal = "age-restricted" | "removed" | "unavailable";

// `refusal: null` is a block, a broken answer or an unknown status, so another
// client or address may still play the video.
export type ClientAnswer =
	| { playable: InnertubeResult }
	| { refusal: Refusal | null };

type ClientContext = {
	clientName: string;
	clientVersion: string;
	hl: string;
	gl: string;
	deviceMake?: string;
	deviceModel?: string;
	osName?: string;
	osVersion?: string;
	androidSdkVersion?: number;
};

export type Client = {
	name: string;
	id: string;
	userAgent: string;
	poToken: "none" | "player";
	client: ClientContext;
	embedUrl?: string;
};

export type Session = {
	visitorData: string;
	fetchedAt: number;
};

export type TokenMinter = {
	mint: (videoId: string) => Promise<string>;
	createdAt: number;
};
