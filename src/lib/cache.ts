import { RedisClient } from "bun";
import { z } from "zod";
import { env } from "config";
import { logger } from "./logger";

const CachedMediaSchema = z.object({
	fileId: z.string().min(1),
	type: z.enum(["video", "photo", "audio"]).optional(),
	width: z.number().finite().nonnegative().optional(),
	height: z.number().finite().nonnegative().optional(),
	duration: z.number().finite().nonnegative().optional(),
	title: z.string().optional(),
	performer: z.string().optional(),
	caption: z
		.object({
			author: z.string().optional(),
			text: z.string().optional(),
			source: z
				.enum([
					"instagram",
					"youtube",
					"tiktok",
					"threads",
					"twitter",
					"reddit",
				])
				.optional(),
		})
		.optional(),
});

export type CachedMedia = z.infer<typeof CachedMediaSchema>;

const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const KEY_PREFIX = "mirai:media:";
const CACHE_DEADLINE_MS = 100;
const CIRCUIT_BREAK_MS = 5_000;
let bypassUntil = 0;

const createRedisClient = (): RedisClient | null => {
	if (!env.REDIS_URL) return null;

	try {
		const instance = new RedisClient(env.REDIS_URL);

		instance.onconnect = () => logger.info("[cache] redis connected");
		instance.onclose = (error) => {
			if (error) logger.warn(`[cache] redis closed: ${error.message}`);
		};

		return instance;
	} catch (error) {
		logger.warn(
			`[cache] redis init failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
};

const client = createRedisClient();

export const normalizeUrl = (url: string): string => {
	try {
		const parsed = new URL(url);
		const host = parsed.host.toLowerCase().replace(/^(?:www|m|mobile)\./, "");
		let path = parsed.pathname.replace(/\/+$/, "");
		const ig = path.match(/^\/(?:reel|reels|p|tv)\/([\w-]+)/);
		if (host === "instagram.com" && ig) path = `/p/${ig[1]}`;
		return `${host}${path}`;
	} catch {
		return url;
	}
};

const keyFor = (url: string): string => `${KEY_PREFIX}${normalizeUrl(url)}`;

const cacheOperation = async <T>(operation: Promise<T>): Promise<T> => {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(
					() => reject(new Error("cache deadline exceeded")),
					CACHE_DEADLINE_MS,
				);
			}),
		]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
};

const tripCircuit = (): void => {
	bypassUntil = Date.now() + CIRCUIT_BREAK_MS;
};

export const getCachedMedia = async (
	url: string,
): Promise<CachedMedia | null> => {
	if (!client) return null;
	if (Date.now() < bypassUntil) return null;
	const key = keyFor(url);
	try {
		const raw = await cacheOperation(client.get(key));
		if (!raw) return null;
		const parsed = CachedMediaSchema.safeParse(JSON.parse(raw));
		if (parsed.success) return parsed.data;

		logger.warn(`[cache] discarded invalid entry ${normalizeUrl(url)}`);
		await cacheOperation(client.del(key));
		return null;
	} catch (error) {
		tripCircuit();
		logger.warn(
			`[cache] get failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
};

export const setCachedMedia = async (
	url: string,
	media: CachedMedia,
): Promise<void> => {
	if (!client) return;
	if (Date.now() < bypassUntil) return;

	try {
		await cacheOperation(
			client.set(keyFor(url), JSON.stringify(media), "EX", TTL_SECONDS),
		);
	} catch (error) {
		tripCircuit();
		logger.warn(
			`[cache] set failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
};

export const deleteCachedMedia = async (url: string): Promise<void> => {
	if (!client) return;
	try {
		await cacheOperation(client.del(keyFor(url)));
	} catch (error) {
		tripCircuit();
		logger.warn(
			`[cache] delete failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
};

export const closeCache = (): void => client?.close();
