import { config } from "config";
import { responseTooLargeFailure } from "./errors";
import { http, readResponseBytes } from "./http";
import { logger } from "./logger";

export type RangedDownloadOptions = Readonly<{
	headers?: HeadersInit;
	connections: number;
	attempts?: number;
	expectedBytes?: number;
	maxBytes: number;
	minBytesPerSecond?: number;
	label: string;
	signal?: AbortSignal;
	timeout?: number;
	proxy?: boolean;
	onBytes?: (bytes: number) => void;
}>;

export type RangedDownload = Readonly<{
	bytes: Uint8Array;
	contentType: string;
}>;

const MIN_PARALLEL_SIZE = 512 * 1024;
const MIN_SPEED_BPS = 100 * 1024;
const MIN_DEADLINE_MS = 10_000;
const MAX_DEADLINE_MS = 90_000;

const deadlineFor = (bytes: number, minBytesPerSecond: number): number =>
	Math.min(
		MAX_DEADLINE_MS,
		Math.max(MIN_DEADLINE_MS, (bytes / minBytesPerSecond) * 1000),
	);

const withRange = (
	headers: HeadersInit | undefined,
	value: string,
): Headers => {
	const ranged = new Headers(headers);
	ranged.set("Range", value);
	return ranged;
};

type Probe = Readonly<{
	total: number;
	contentType: string;
	full?: Uint8Array;
}>;

const probeSource = async (
	url: string,
	options: RangedDownloadOptions,
	signal: AbortSignal,
): Promise<Probe> => {
	const response = await http(url, {
		headers: withRange(options.headers, "bytes=0-0"),
		responseType: "raw",
		attempts: options.attempts ?? 1,
		timeout: options.timeout ?? config.http.timeout,
		...(options.proxy !== undefined ? { proxy: options.proxy } : {}),
		signal,
	});
	const contentType = response.headers.get("content-type") ?? "";

	if (response.status === 206) {
		const match = response.headers
			.get("content-range")
			?.match(/^bytes 0-0\/(\d+)$/i);
		const total = Number(match?.[1] ?? 0);
		await response.body?.cancel();
		if (total <= 0) throw new Error("invalid probe content-range");
		if (total > options.maxBytes) {
			throw responseTooLargeFailure(options.maxBytes, total);
		}
		return { total, contentType };
	}

	if (response.ok) {
		const full = await readResponseBytes(
			response,
			options.maxBytes,
			options.onBytes,
		);
		return { total: full.length, contentType, full };
	}

	throw new Error(`probe ${response.status}`);
};

const settleRanges = async <T>(
	requests: readonly Promise<T>[],
	controller: AbortController,
): Promise<T[]> => {
	try {
		return await Promise.all(requests);
	} catch (error) {
		controller.abort(error);
		await Promise.allSettled(requests);
		throw error;
	}
};

export const downloadInRanges = async (
	url: string,
	options: RangedDownloadOptions,
): Promise<RangedDownload> => {
	const startedAt = performance.now();
	const connections = Math.max(1, Math.floor(options.connections));
	const controller = new AbortController();
	const abortFromParent = () => controller.abort(options.signal?.reason);
	if (options.signal?.aborted) abortFromParent();
	else
		options.signal?.addEventListener("abort", abortFromParent, { once: true });

	let deadlineExpired = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		const expectedBytes =
			options.expectedBytes !== undefined &&
			Number.isFinite(options.expectedBytes) &&
			options.expectedBytes > 0
				? Math.floor(options.expectedBytes)
				: undefined;
		if (expectedBytes !== undefined && expectedBytes > options.maxBytes) {
			throw responseTooLargeFailure(options.maxBytes, expectedBytes);
		}

		const probe = expectedBytes
			? { total: expectedBytes, contentType: "" }
			: await probeSource(url, options, controller.signal);
		if (probe.full) {
			logger.info(
				`[download] ${options.label}: ${sizeOf(probe.full)} in ${elapsedSince(startedAt)} (1x)`,
			);
			return { bytes: probe.full, contentType: probe.contentType };
		}

		timer = setTimeout(
			() => {
				deadlineExpired = true;
				controller.abort(`${options.label} download deadline exceeded`);
			},
			deadlineFor(probe.total, options.minBytesPerSecond ?? MIN_SPEED_BPS),
		);

		if (connections === 1 || probe.total < MIN_PARALLEL_SIZE) {
			const response = await http(url, {
				headers: withRange(options.headers, `bytes=0-${probe.total - 1}`),
				responseType: "raw",
				attempts: options.attempts ?? 1,
				timeout: options.timeout ?? config.http.timeout,
				...(options.proxy !== undefined ? { proxy: options.proxy } : {}),
				signal: controller.signal,
			});
			const bytes = await readResponseBytes(
				response,
				options.maxBytes,
				options.onBytes,
			);
			if (bytes.length !== probe.total) {
				throw new Error(`unexpected size for ${options.label}`);
			}
			logger.info(
				`[download] ${options.label}: ${sizeOf(bytes)} in ${elapsedSince(startedAt)} (1x)`,
			);
			return {
				bytes,
				contentType: response.headers.get("content-type") ?? probe.contentType,
			};
		}

		const chunkSize = Math.ceil(probe.total / connections);
		const requests = Array.from({ length: connections }, async (_, index) => {
			const start = index * chunkSize;
			const end = Math.min(start + chunkSize - 1, probe.total - 1);
			if (start > end) {
				return { bytes: new Uint8Array(), contentType: "" };
			}

			const response = await http(url, {
				headers: withRange(options.headers, `bytes=${start}-${end}`),
				responseType: "raw",
				attempts: options.attempts ?? 1,
				timeout: options.timeout ?? config.http.timeout,
				...(options.proxy !== undefined ? { proxy: options.proxy } : {}),
				signal: controller.signal,
			});
			if (response.status !== 206) {
				await response.body?.cancel();
				throw new Error(`fetch ${response.status} range for ${options.label}`);
			}

			const expected = end - start + 1;
			const contentRange = response.headers
				.get("content-range")
				?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
			if (
				Number(contentRange?.[1]) !== start ||
				Number(contentRange?.[2]) !== end ||
				Number(contentRange?.[3]) !== probe.total
			) {
				await response.body?.cancel();
				throw new Error(`invalid content-range for ${options.label}`);
			}

			const part = await readResponseBytes(response, expected, options.onBytes);
			if (part.length !== expected) {
				throw new Error(`short range for ${options.label}`);
			}
			return {
				bytes: part,
				contentType: response.headers.get("content-type") ?? "",
			};
		});
		const parts = await settleRanges(requests, controller);

		const bytes = new Uint8Array(probe.total);
		let offset = 0;
		for (const part of parts) {
			bytes.set(part.bytes, offset);
			offset += part.bytes.length;
		}
		logger.info(
			`[download] ${options.label}: ${sizeOf(bytes)} in ${elapsedSince(startedAt)} (${connections}x)`,
		);
		return {
			bytes,
			contentType:
				probe.contentType ||
				parts.find((part) => part.contentType)?.contentType ||
				"",
		};
	} catch (error) {
		if (!controller.signal.aborted) controller.abort(error);
		if (deadlineExpired && !options.signal?.aborted) {
			throw new Error(`${options.label} download too slow (dead proxy ip)`);
		}
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
		options.signal?.removeEventListener("abort", abortFromParent);
	}
};

const sizeOf = (bytes: Uint8Array): string =>
	`${(bytes.byteLength / 1024 / 1024).toFixed(2)}MB`;

const elapsedSince = (startedAt: number): string =>
	`${(performance.now() - startedAt).toFixed(0)}ms`;
