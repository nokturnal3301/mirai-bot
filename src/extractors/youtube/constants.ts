import type { Client } from "extractors/youtube/types";

export const CHROME_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const YOUTUBE_HOME_URL = "https://www.youtube.com/";
export const PLAYER_ENDPOINT =
	"https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

export const ATTESTATION_API_URL =
	"https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa";
export const ATTESTATION_HEADERS: Record<string, string> = {
	"content-type": "application/json+protobuf",
	"x-goog-api-key": "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw",
	"x-user-agent": "grpc-web-javascript/0.1",
};
export const BOTGUARD_REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";

export const MINTER_TTL_MS = 11 * 60 * 60 * 1000;
export const MINTER_RETRY_DELAY_MS = 60 * 1000;
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
export const PLAYER_RESPONSE_TTL_MS = 2 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 6_000;
export const DOWNLOAD_CONNECTIONS = 8;
export const DOWNLOAD_MIN_BYTES_PER_SECOND = 512 * 1024;

export const VIDEO_ID_PATTERNS = [
	/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
	/youtu\.be\/([a-zA-Z0-9_-]{11})/,
	/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
];

export const TRUSTED_BOTGUARD_HOSTS =
	/(\.|^)(youtube\.com|ytimg\.com|google\.com|googleapis\.com|gstatic\.com)$/i;

export const CLIENTS: Client[] = [
	{
		name: "visionos",
		id: "101",
		poToken: "none",
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
		client: {
			clientName: "VISIONOS",
			clientVersion: "1.02",
			deviceMake: "Apple",
			deviceModel: "RealityDevice17,1",
			osName: "visionOS",
			osVersion: "26.5.23O471",
			hl: "en",
			gl: "US",
		},
	},
	{
		name: "web_embedded",
		id: "56",
		poToken: "none",
		userAgent: CHROME_UA,
		embedUrl: "https://www.reddit.com/",
		client: {
			clientName: "WEB_EMBEDDED_PLAYER",
			clientVersion: "2.20260708.00.00",
			hl: "en",
			gl: "US",
		},
	},
	{
		name: "ios",
		id: "5",
		poToken: "player",
		userAgent:
			"com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
		client: {
			clientName: "IOS",
			clientVersion: "21.26.4",
			deviceMake: "Apple",
			deviceModel: "iPhone16,2",
			osName: "iPhone",
			osVersion: "18.3.2.22D82",
			hl: "en",
			gl: "US",
		},
	},
];

export const SESSION_ROLLS = 3;
export const ROUTE_HEDGE_DELAY_MS = 1_500;
