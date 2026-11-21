import type { ExtractionError } from "lib/errors";
import type { Flow } from "lib/flow";
import type { Caption, Media, MediaItem, RemoteMediaResource } from "./types";

import { config } from "config";
import {
	F,
	download,
	extractionError,
	extractionErrorFrom,
	getHttpContext,
	logger,
	mapConcurrent,
	mux,
	warmFfmpeg,
	withHttpContext,
} from "lib";
import { DOWNLOAD_MIN_BYTES_PER_SECOND } from "./constants";

type HttpContext = NonNullable<RemoteMediaResource["httpContext"]>;

type SourceMetadata = Readonly<{
	headers?: Record<string, string>;
	httpContext?: HttpContext;
}>;

export type ReadySource = Readonly<{
	kind: "ready";
	data: Blob | string;
}>;

export type DownloadSource = SourceMetadata &
	Readonly<{
		kind: "download";
		url: string;
		attempts?: number;
		timeout?: number;
		proxy?: boolean;
		connections?: number;
		expectedBytes?: number;
		minBytesPerSecond?: number;
	}>;

export type RemoteSource = SourceMetadata &
	Readonly<{
		kind: "remote";
		url: string;
		size?: number;
		telegramFetch?: boolean;
		connections?: number;
	}>;

export type MuxSource = SourceMetadata &
	Readonly<{
		kind: "mux";
		videoUrl: string;
		audioUrl: string;
		// Exact sizes spare a size probe before each stream download.
		videoBytes?: number;
		audioBytes?: number;
		timeout?: number;
		videoCodecCompatible?: boolean;
	}>;

export type FileSource = ReadySource | DownloadSource | RemoteSource;
export type AtomicVideoSource = FileSource | MuxSource;
export type VideoSource =
	| AtomicVideoSource
	| Readonly<{
			kind: "fallback";
			sources: readonly AtomicVideoSource[];
	  }>;

export type MediaItemPlan =
	| Readonly<{
			type: "video";
			source: VideoSource;
			width?: number;
			height?: number;
			duration?: number;
	  }>
	| Readonly<{
			type: "photo";
			source: FileSource;
			width?: number;
			height?: number;
	  }>;

export type AudioPlan = Readonly<{
	source: FileSource;
	duration?: number;
	title?: string;
	performer?: string;
}>;

export type MediaPlan =
	| Readonly<{
			type: "video";
			source: VideoSource;
			width?: number;
			height?: number;
			duration?: number;
			caption?: Caption;
	  }>
	| Readonly<{
			type: "photo";
			source: FileSource;
			width?: number;
			height?: number;
			caption?: Caption;
	  }>
	| Readonly<{
			type: "audio";
			source: FileSource;
			duration?: number;
			title?: string;
			performer?: string;
	  }>
	| Readonly<{
			type: "carousel";
			items: readonly MediaItemPlan[];
			caption?: Caption;
			audio?: AudioPlan;
			maxBytes?: number;
	  }>
	| Readonly<{ type: "text"; caption: Caption }>;

// CDN URLs are not bound to the address that asked for them, so the bytes go
// straight from the datacenter first. The route the post came through, usually
// the residential proxy, stays as a fallback for edges that refuse the direct one.
export const directThenProxy = (
	download: Omit<DownloadSource, "httpContext" | "minBytesPerSecond">,
): [DownloadSource, DownloadSource] => [
	{
		...download,
		minBytesPerSecond: DOWNLOAD_MIN_BYTES_PER_SECOND,
		httpContext: { forceProxy: false },
	},
	{ ...download, httpContext: getHttpContext() ?? { forceProxy: true } },
];

// A post with a single photo or video is that item plus the post's caption.
export const planOfItem = (
	item: MediaItemPlan,
	caption?: Caption,
): MediaPlan => ({ ...item, caption });

const messageOf = (error: unknown): string =>
	error instanceof Error
		? error.message
		: typeof error === "object" && error !== null && "message" in error
			? String(error.message)
			: String(error);

const inHttpContext = <T>(
	context: HttpContext | undefined,
	run: () => Promise<T>,
): Promise<T> => (context ? withHttpContext(context, run) : run());

const downloadSource = (
	source: DownloadSource | RemoteSource,
	signal?: AbortSignal,
): Promise<Blob> =>
	inHttpContext(source.httpContext, () =>
		download(source.url, {
			headers: source.headers,
			connections: source.connections,
			signal,
			...(source.kind === "download"
				? {
						attempts: source.attempts,
						timeout: source.timeout,
						proxy: source.proxy,
						expectedBytes: source.expectedBytes,
						minBytesPerSecond: source.minBytesPerSecond,
					}
				: {}),
		}),
	);

const muxSource = async (
	source: MuxSource,
	signal?: AbortSignal,
): Promise<Blob> => {
	warmFfmpeg();
	const { videoUrl, audioUrl, videoBytes, audioBytes, headers, timeout } =
		source;
	try {
		const data = await inHttpContext(source.httpContext, () =>
			mux({
				videoUrl,
				audioUrl,
				videoBytes,
				audioBytes,
				headers,
				timeout,
				videoCodecCompatible: source.videoCodecCompatible,
				signal,
			}),
		);
		if (!data) {
			throw extractionError("DOWNLOAD_FAILED", "mux returned no data");
		}
		return data;
	} catch (error) {
		const typed = extractionErrorFrom(error);
		throw typed.code === "UNKNOWN"
			? extractionError("DOWNLOAD_FAILED", typed.message)
			: typed;
	}
};

const materializeVideoSource = async (
	source: VideoSource,
	signal?: AbortSignal,
): Promise<Blob | string | RemoteMediaResource> => {
	switch (source.kind) {
		case "ready":
			return source.data;
		case "download":
			return downloadSource(source, signal);
		case "remote": {
			const { url, headers, size, telegramFetch, connections, httpContext } =
				source;
			return {
				kind: "remote",
				url,
				headers,
				size,
				telegramFetch,
				connections,
				httpContext,
			};
		}
		case "mux":
			return muxSource(source, signal);
		case "fallback": {
			let lastError: unknown = extractionError("NO_MEDIA", "no video sources");
			for (const candidate of source.sources) {
				try {
					return await materializeVideoSource(candidate, signal);
				} catch (error) {
					lastError = error;
				}
			}
			throw lastError;
		}
	}
};

const materializeFileSource = async (
	source: FileSource,
	signal?: AbortSignal,
): Promise<Blob | string> => {
	if (source.kind === "ready") return source.data;
	if (
		source.kind === "remote" &&
		source.telegramFetch !== false &&
		!source.headers &&
		!source.httpContext
	) {
		return source.url;
	}
	return downloadSource(source, signal);
};

// A carousel is still worth sending without one of its items, so a failure
// costs the item, not the post. The reason goes to the log.
const materializeItem = async (
	item: MediaItemPlan,
	label: string,
	signal?: AbortSignal,
): Promise<MediaItem | null> => {
	try {
		const data =
			item.source.kind === "mux" || item.source.kind === "fallback"
				? await materializeVideoSource(item.source, signal)
				: await materializeFileSource(item.source, signal);
		if (typeof data === "object" && !(data instanceof Blob)) {
			logger.warn(`[carousel] ${label} skipped: source needs Telegram fetch`);
			return null;
		}
		return {
			type: item.type,
			data,
			width: item.width,
			height: item.height,
			duration: item.type === "video" ? item.duration : undefined,
		};
	} catch (error) {
		logger.warn(`[carousel] ${label} skipped: ${messageOf(error)}`);
		return null;
	}
};

const materializeAudio = async (
	plan: AudioPlan | undefined,
	signal?: AbortSignal,
): Promise<Extract<Media, { type: "carousel" }>["audio"]> => {
	if (!plan) return undefined;
	try {
		return {
			data: await materializeFileSource(plan.source, signal),
			duration: plan.duration,
			title: plan.title || undefined,
			performer: plan.performer || undefined,
		};
	} catch (error) {
		// A carousel remains useful when its optional soundtrack is unavailable.
		logger.warn(`[carousel] soundtrack skipped: ${messageOf(error)}`);
		return undefined;
	}
};

// Photos are small, so several download at once; videos already open
// parallel ranges each.
const carouselConcurrency = (items: readonly MediaItemPlan[]): number =>
	items.some((item) => item.type === "video") ? 3 : 6;

const materializeCarousel = async (
	plan: Extract<MediaPlan, { type: "carousel" }>,
	signal?: AbortSignal,
): Promise<Flow<Media, ExtractionError>> => {
	const maxBytes = plan.maxBytes ?? config.telegram.maxCarouselBytes;
	const total = plan.items.length;
	let totalBytes = 0;
	const planned = plan.items.slice(0, config.telegram.maxCarouselItems);
	const [materialized, audio] = await Promise.all([
		mapConcurrent(
			planned,
			carouselConcurrency(planned),
			async (item, index) => {
				const label = `item ${index + 1}/${total}`;
				const result = await materializeItem(item, label, signal);
				if (!result) return null;
				const bytes = result.data instanceof Blob ? result.data.size : 0;
				if (totalBytes + bytes > maxBytes) {
					logger.warn(`[carousel] ${label} skipped: over the size budget`);
					return null;
				}
				totalBytes += bytes;
				return result;
			},
		),
		materializeAudio(plan.audio, signal),
	]);
	const items = materialized.filter((item): item is MediaItem => item !== null);
	if (items.length === 0)
		return F.fail(extractionError("NO_MEDIA", "no carousel items"));
	if (items.length < total) {
		logger.warn(`[carousel] kept ${items.length} of ${total} items`);
	}

	return F.of({
		type: "carousel",
		items,
		total: items.length < total ? total : undefined,
		caption: plan.caption,
		audio,
	});
};

export const materializeMedia = async (
	plan: MediaPlan,
	signal?: AbortSignal,
): Promise<Flow<Media, ExtractionError>> => {
	try {
		switch (plan.type) {
			case "text":
				return F.of(plan);
			case "carousel":
				return materializeCarousel(plan, signal);
			case "video":
				return F.of({
					type: "video",
					data: await materializeVideoSource(plan.source, signal),
					width: plan.width,
					height: plan.height,
					duration: plan.duration,
					caption: plan.caption,
				});
			case "photo":
				return F.of({
					type: "photo",
					data: await materializeFileSource(plan.source, signal),
					width: plan.width,
					height: plan.height,
					caption: plan.caption,
				});
			case "audio":
				return F.of({
					type: "audio",
					data: await materializeFileSource(plan.source, signal),
					duration: plan.duration,
					title: plan.title || undefined,
					performer: plan.performer || undefined,
				});
		}
	} catch (error) {
		return F.fail(extractionErrorFrom(error));
	}
};
