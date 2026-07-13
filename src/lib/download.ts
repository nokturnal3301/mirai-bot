import { config } from "config";
import {
	extractionError,
	HttpStatusError,
	HttpTimeoutError,
	isExtractionError,
	isResponseTooLargeFailure,
} from "./errors";
import { http, type HttpOptions } from "./http";
import { logger } from "./logger";
import { downloadInRanges } from "./ranged-download";

export type DownloadOptions = Pick<
	HttpOptions<"blob">,
	"attempts" | "headers" | "proxy" | "signal" | "timeout"
> & {
	connections?: number;
	expectedBytes?: number;
	label?: string;
	minBytesPerSecond?: number;
};

export const download = async (
	url: string,
	options: DownloadOptions = {},
): Promise<Blob> => {
	try {
		const {
			connections = 1,
			expectedBytes,
			label = "media",
			minBytesPerSecond,
			...httpOptions
		} = options;
		if (connections > 1) {
			const result = await downloadInRanges(url, {
				headers: httpOptions.headers,
				connections,
				...(expectedBytes !== undefined ? { expectedBytes } : {}),
				maxBytes: config.telegram.maxFileSize,
				label,
				...(minBytesPerSecond !== undefined ? { minBytesPerSecond } : {}),
				...(httpOptions.signal ? { signal: httpOptions.signal } : {}),
				...(httpOptions.attempts !== undefined
					? { attempts: httpOptions.attempts }
					: {}),
				...(httpOptions.timeout !== undefined
					? { timeout: httpOptions.timeout }
					: {}),
				...(httpOptions.proxy !== undefined
					? { proxy: httpOptions.proxy }
					: {}),
			});
			return new Blob([result.bytes.buffer as ArrayBuffer], {
				type: result.contentType,
			});
		}

		return await http(url, {
			...httpOptions,
			responseType: "blob",
			maxBytes: config.telegram.maxFileSize,
		});
	} catch (error) {
		if (isResponseTooLargeFailure(error)) {
			const actual = error.actualBytes
				? `${(error.actualBytes / 1024 / 1024).toFixed(1)}MB`
				: "unknown size";

			logger.warn(
				`[download] rejected ${actual} response before Telegram upload`,
			);
		}
		if (
			isResponseTooLargeFailure(error) ||
			isExtractionError(error) ||
			error instanceof HttpStatusError ||
			error instanceof HttpTimeoutError
		) {
			throw error;
		}
		throw extractionError(
			"DOWNLOAD_FAILED",
			error instanceof Error ? error.message : String(error),
		);
	}
};
