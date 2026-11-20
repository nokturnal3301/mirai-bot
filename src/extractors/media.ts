import type { ExtractionError } from "lib/errors";
import type { Flow } from "lib/flow";
import type { Caption, Media, MediaItem, RemoteMediaResource } from "./types";

import { config } from "config";
import {
	F,
	download,
	extractionError,
	extractionErrorFrom,
	mapConcurrent,
	mux,
	withHttpContext,
} from "lib";

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
			...(source.headers ? { headers: source.headers } : {}),
			...(signal ? { signal } : {}),
			...(source.kind === "download" && source.attempts !== undefined
				? { attempts: source.attempts }
				: {}),
			...(source.kind === "download" && source.timeout !== undefined
				? { timeout: source.timeout }
				: {}),
			...(source.kind === "download" && source.proxy !== undefined
				? { proxy: source.proxy }
				: {}),
			...(source.connections !== undefined
				? { connections: source.connections }
				: {}),
			...(source.kind === "download" && source.expectedBytes !== undefined
				? { expectedBytes: source.expectedBytes }
				: {}),
			...(source.kind === "download" && source.minBytesPerSecond !== undefined
				? { minBytesPerSecond: source.minBytesPerSecond }
				: {}),
		}),
	);

const materializeVideoSource = async (
	source: VideoSource,
	signal?: AbortSignal,
): Promise<Blob | string | RemoteMediaResource> => {
	switch (source.kind) {
		case "ready":
			return source.data;
		case "download":
			return downloadSource(source, signal);
		case "remote":
			return {
				kind: "remote",
				url: source.url,
				...(source.headers ? { headers: source.headers } : {}),
				...(source.size !== undefined ? { size: source.size } : {}),
				...(source.telegramFetch !== undefined
					? { telegramFetch: source.telegramFetch }
					: {}),
				...(source.connections !== undefined
					? { connections: source.connections }
					: {}),
				...(source.httpContext ? { httpContext: source.httpContext } : {}),
			};
		case "mux": {
			try {
				const data = await inHttpContext(source.httpContext, () =>
					mux({
						videoUrl: source.videoUrl,
						audioUrl: source.audioUrl,
						...(source.videoBytes ? { videoBytes: source.videoBytes } : {}),
						...(source.audioBytes ? { audioBytes: source.audioBytes } : {}),
						...(source.headers ? { headers: source.headers } : {}),
						...(source.timeout !== undefined
							? { timeout: source.timeout }
							: {}),
						...(source.videoCodecCompatible !== undefined
							? { videoCodecCompatible: source.videoCodecCompatible }
							: {}),
						...(signal ? { signal } : {}),
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
		}
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

const materializeItem = async (
	item: MediaItemPlan,
	signal?: AbortSignal,
): Promise<MediaItem | null> => {
	try {
		const data =
			item.source.kind === "mux" || item.source.kind === "fallback"
				? await materializeVideoSource(item.source, signal)
				: await materializeFileSource(item.source, signal);
		if (typeof data === "object" && !(data instanceof Blob)) return null;
		return {
			type: item.type,
			data,
			...(item.width !== undefined ? { width: item.width } : {}),
			...(item.height !== undefined ? { height: item.height } : {}),
			...(item.type === "video" && item.duration !== undefined
				? { duration: item.duration }
				: {}),
		};
	} catch {
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
			...(plan.duration !== undefined ? { duration: plan.duration } : {}),
			...(plan.title ? { title: plan.title } : {}),
			...(plan.performer ? { performer: plan.performer } : {}),
		};
	} catch {
		// A carousel remains useful when its optional soundtrack is unavailable.
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
	let totalBytes = 0;
	const planned = plan.items.slice(0, config.telegram.maxCarouselItems);
	const [materialized, audio] = await Promise.all([
		mapConcurrent(planned, carouselConcurrency(planned), async (item) => {
			const result = await materializeItem(item, signal);
			if (!result) return null;
			const bytes = result.data instanceof Blob ? result.data.size : 0;
			if (totalBytes + bytes > maxBytes) return null;
			totalBytes += bytes;
			return result;
		}),
		materializeAudio(plan.audio, signal),
	]);
	const items = materialized.filter((item): item is MediaItem => item !== null);
	if (items.length === 0)
		return F.fail(extractionError("NO_MEDIA", "no carousel items"));

	return F.of({
		type: "carousel",
		items,
		...(plan.caption ? { caption: plan.caption } : {}),
		...(audio ? { audio } : {}),
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
					...(plan.width !== undefined ? { width: plan.width } : {}),
					...(plan.height !== undefined ? { height: plan.height } : {}),
					...(plan.duration !== undefined ? { duration: plan.duration } : {}),
					...(plan.caption ? { caption: plan.caption } : {}),
				});
			case "photo":
				return F.of({
					type: "photo",
					data: await materializeFileSource(plan.source, signal),
					...(plan.width !== undefined ? { width: plan.width } : {}),
					...(plan.height !== undefined ? { height: plan.height } : {}),
					...(plan.caption ? { caption: plan.caption } : {}),
				});
			case "audio":
				return F.of({
					type: "audio",
					data: await materializeFileSource(plan.source, signal),
					...(plan.duration !== undefined ? { duration: plan.duration } : {}),
					...(plan.title ? { title: plan.title } : {}),
					...(plan.performer ? { performer: plan.performer } : {}),
				});
		}
	} catch (error) {
		return F.fail(extractionErrorFrom(error));
	}
};
