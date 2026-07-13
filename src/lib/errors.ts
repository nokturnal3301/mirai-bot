export type ExtractionErrorCode =
	| "NOT_APPLICABLE"
	| "UPSTREAM_REJECTED"
	| "SCHEMA_MISMATCH"
	| "DOWNLOAD_FAILED"
	| "MEDIA_TOO_LARGE"
	| "NO_MEDIA"
	| "ABORTED"
	| "UNKNOWN";

export class HttpTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number, options?: ErrorOptions) {
		super(`HTTP timeout after ${timeoutMs}ms`, options);
		this.name = "HttpTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export class HttpStatusError extends Error {
	readonly status: number;
	readonly url: string;

	constructor(status: number, url: string, options?: ErrorOptions) {
		super(`HTTP ${status}`, options);
		this.name = "HttpStatusError";
		this.status = status;
		this.url = url;
	}
}

export type ExtractionError = Readonly<{
	code: ExtractionErrorCode;
	message: string;
	retryable: boolean;
	terminal: boolean;
	details?: Readonly<Record<string, unknown>>;
}>;

type ExtractionErrorOptions = {
	retryable?: boolean;
	terminal?: boolean;
	details?: Readonly<Record<string, unknown>>;
};

const DEFAULTS: Record<
	ExtractionErrorCode,
	Pick<ExtractionError, "retryable" | "terminal">
> = {
	NOT_APPLICABLE: { retryable: false, terminal: false },
	UPSTREAM_REJECTED: { retryable: true, terminal: false },
	SCHEMA_MISMATCH: { retryable: false, terminal: false },
	DOWNLOAD_FAILED: { retryable: true, terminal: false },
	MEDIA_TOO_LARGE: { retryable: false, terminal: true },
	NO_MEDIA: { retryable: true, terminal: false },
	ABORTED: { retryable: false, terminal: true },
	UNKNOWN: { retryable: false, terminal: false },
};

const ERROR_CODES = new Set<ExtractionErrorCode>([
	"NOT_APPLICABLE",
	"UPSTREAM_REJECTED",
	"SCHEMA_MISMATCH",
	"DOWNLOAD_FAILED",
	"MEDIA_TOO_LARGE",
	"NO_MEDIA",
	"ABORTED",
	"UNKNOWN",
]);

export const extractionError = (
	code: ExtractionErrorCode,
	message: string,
	options: ExtractionErrorOptions = {},
): ExtractionError => ({
	code,
	message,
	retryable: options.retryable ?? DEFAULTS[code].retryable,
	terminal: options.terminal ?? DEFAULTS[code].terminal,
	...(options.details ? { details: options.details } : {}),
});

export const isExtractionError = (error: unknown): error is ExtractionError =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	typeof error.code === "string" &&
	ERROR_CODES.has(error.code as ExtractionErrorCode) &&
	"message" in error &&
	typeof error.message === "string" &&
	"retryable" in error &&
	typeof error.retryable === "boolean" &&
	"terminal" in error &&
	typeof error.terminal === "boolean";

export const isRetryableHttpStatus = (status: number): boolean =>
	status === 408 || status === 429 || status >= 500;

const isAbortFailure = (error: unknown): error is Error =>
	error instanceof Error && error.name === "AbortError";

export const extractionErrorFrom = (error: unknown): ExtractionError => {
	if (isExtractionError(error)) return error;
	if (error instanceof HttpTimeoutError) {
		return extractionError("UPSTREAM_REJECTED", error.message);
	}
	if (error instanceof HttpStatusError) {
		return extractionError("UPSTREAM_REJECTED", error.message, {
			retryable:
				error.status === 401 ||
				error.status === 403 ||
				isRetryableHttpStatus(error.status),
			details: { status: error.status, url: error.url },
		});
	}
	if (isResponseTooLargeFailure(error)) {
		return extractionError("MEDIA_TOO_LARGE", error.message, {
			details: {
				actualBytes: error.actualBytes,
				limitBytes: error.limitBytes,
			},
		});
	}
	if (isAbortFailure(error)) {
		return extractionError("ABORTED", error.message);
	}
	const message = error instanceof Error ? error.message : String(error);
	return extractionError("UNKNOWN", message);
};

export type ResponseTooLargeFailure = Error & {
	_tag: "ResponseTooLarge";
	actualBytes?: number;
	limitBytes: number;
};

export const responseTooLargeFailure = (
	limitBytes: number,
	actualBytes?: number,
): ResponseTooLargeFailure =>
	Object.assign(Error("FILE_TOO_LARGE"), {
		_tag: "ResponseTooLarge" as const,
		actualBytes,
		limitBytes,
	});

export const isResponseTooLargeFailure = (
	error: unknown,
): error is ResponseTooLargeFailure =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	error._tag === "ResponseTooLarge";
