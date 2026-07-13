import { config, env } from "config";
import {
	HttpStatusError,
	HttpTimeoutError,
	isRetryableHttpStatus,
	isResponseTooLargeFailure,
	responseTooLargeFailure,
} from "./errors";
import { logger } from "./logger";
import { assertPublicHttpUrl } from "./url";
import { getHttpContext, resolveProxyUrl } from "./http-context";

type ResponseType =
	| "json"
	| "text"
	| "textWithHeaders"
	| "blob"
	| "arrayBuffer"
	| "raw";

export type HttpTextResponse = {
	body: string;
	headers: Headers;
	status: number;
	url: string;
};

export type HttpOptions<R extends ResponseType> = RequestInit & {
	attempts?: number;
	timeout?: number;
	responseType?: R;
	proxy?: boolean;
	allowPrivate?: boolean;
	maxBytes?: number;
};

type ResponseMap = {
	json: unknown;
	text: string;
	textWithHeaders: HttpTextResponse;
	blob: Blob;
	arrayBuffer: ArrayBuffer;
	raw: Response;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableError = (error: Error): boolean => {
	if (isResponseTooLargeFailure(error)) return false;
	if (error instanceof HttpStatusError) {
		return isRetryableHttpStatus(error.status);
	}
	return true;
};

const contentLengthOf = (response: Response): number | undefined => {
	const raw = response.headers.get("content-length");
	if (!raw) return undefined;
	const size = Number(raw);
	return Number.isFinite(size) && size >= 0 ? size : undefined;
};

export const readResponseBytes = async (
	response: Response,
	maxBytes: number,
	onBytes?: (bytes: number) => void,
): Promise<Uint8Array> => {
	const declaredSize = contentLengthOf(response);
	if (declaredSize !== undefined && declaredSize > maxBytes) {
		await response.body?.cancel();
		throw responseTooLargeFailure(maxBytes, declaredSize);
	}

	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				throw responseTooLargeFailure(maxBytes, size);
			}
			onBytes?.(value.byteLength);
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}

	const output = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
};

const readLimitedBlob = async (
	response: Response,
	limit: number,
): Promise<Blob> => {
	const declaredSize = contentLengthOf(response);
	if (declaredSize !== undefined && declaredSize > limit) {
		await response.body?.cancel();
		throw responseTooLargeFailure(limit, declaredSize);
	}

	if (!response.body) {
		const blob = await response.blob();
		if (blob.size > limit) throw responseTooLargeFailure(limit, blob.size);
		return blob;
	}

	const reader = response.body.getReader();
	const chunks: ArrayBuffer[] = [];
	let size = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			throw responseTooLargeFailure(limit, size);
		}
		const copy = new Uint8Array(value.byteLength);
		copy.set(value);
		chunks.push(copy.buffer);
	}

	return new Blob(chunks, {
		type: response.headers.get("content-type") ?? "",
	});
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

const fetchWithCheckedRedirects = async (
	url: string,
	init: RequestInit & { proxy?: string },
	signal: AbortSignal,
	allowPrivate: boolean,
): Promise<Response> => {
	const redirectMode = init.redirect ?? "follow";
	let currentUrl = url;
	let method = (init.method ?? "GET").toUpperCase();
	let body = init.body;
	let headers = new Headers(init.headers);

	for (let redirects = 0; ; redirects++) {
		if (!allowPrivate) assertPublicHttpUrl(currentUrl);
		const response = await fetch(currentUrl, {
			...init,
			body,
			headers,
			method,
			redirect: "manual",
			signal,
		});

		if (redirectMode === "manual" || !REDIRECT_STATUSES.has(response.status)) {
			return response;
		}
		if (redirectMode === "error") {
			await response.body?.cancel();
			throw new Error(`HTTP redirect ${response.status}`);
		}
		if (redirects >= MAX_REDIRECTS) {
			await response.body?.cancel();
			throw new Error("HTTP redirect limit exceeded");
		}

		const location = response.headers.get("location");
		if (!location) return response;
		const nextUrl = new URL(location, currentUrl).toString();
		if (!allowPrivate) assertPublicHttpUrl(nextUrl);

		if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
			headers = new Headers(headers);
			headers.delete("authorization");
			headers.delete("cookie");
			headers.delete("proxy-authorization");
		}

		if (
			response.status === 303 ||
			((response.status === 301 || response.status === 302) &&
				method === "POST")
		) {
			method = "GET";
			body = undefined;
			headers.delete("content-length");
			headers.delete("content-type");
		}

		await response.body?.cancel();
		currentUrl = nextUrl;
	}
};

export async function http<T = unknown>(
	url: string,
	options?: HttpOptions<"json">,
): Promise<T>;

export async function http(
	url: string,
	options: HttpOptions<"text">,
): Promise<string>;

export async function http(
	url: string,
	options: HttpOptions<"textWithHeaders">,
): Promise<HttpTextResponse>;

export async function http(
	url: string,
	options: HttpOptions<"blob">,
): Promise<Blob>;

export async function http(
	url: string,
	options: HttpOptions<"arrayBuffer">,
): Promise<ArrayBuffer>;

export async function http(
	url: string,
	options: HttpOptions<"raw">,
): Promise<Response>;

export async function http<R extends ResponseType = "json">(
	url: string,
	options?: HttpOptions<R>,
): Promise<ResponseMap[R]> {
	if (!options?.allowPrivate) assertPublicHttpUrl(url);

	const {
		attempts: attemptsOpt,
		timeout: timeoutOpt,
		responseType: responseTypeOpt,
		proxy: useProxy,
		allowPrivate = false,
		maxBytes,
		signal: externalSignal,
		...fetchRest
	} = options ?? {};

	const attempts = attemptsOpt ?? config.http.attempts;
	const timeout = timeoutOpt ?? config.http.timeout;
	const responseType = responseTypeOpt ?? "json";

	const fetchInit: RequestInit & { proxy?: string } = { ...fetchRest };
	const ctx = getHttpContext();
	const shouldUseProxy = (useProxy || ctx?.forceProxy) === true;
	if (shouldUseProxy && env.PROXY_URL) {
		fetchInit.proxy = resolveProxyUrl(env.PROXY_URL, ctx?.proxySession);
	}

	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= attempts; attempt++) {
		const controller = new AbortController();
		const signal = externalSignal
			? AbortSignal.any([controller.signal, externalSignal])
			: controller.signal;
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		try {
			const result = await fetchWithCheckedRedirects(
				url,
				fetchInit,
				signal,
				allowPrivate,
			);

			if (responseType === "raw") {
				if (fetchInit.redirect !== "manual" && !result.ok) {
					await result.body?.cancel();
					throw new HttpStatusError(result.status, result.url || url);
				}
				return result as ResponseMap[R];
			}

			if (!result.ok) {
				throw new HttpStatusError(result.status, result.url || url);
			}

			if (responseType === "blob" && maxBytes !== undefined) {
				return (await readLimitedBlob(result, maxBytes)) as ResponseMap[R];
			}

			if (responseType === "textWithHeaders") {
				const blob = await readLimitedBlob(
					result,
					maxBytes ?? config.http.maxDocumentSize,
				);
				return {
					body: await blob.text(),
					headers: result.headers,
					status: result.status,
					url: result.url,
				} as ResponseMap[R];
			}

			const method = responseType as "json" | "text" | "blob" | "arrayBuffer";
			return (await result[method]()) as ResponseMap[R];
		} catch (error) {
			lastError =
				controller.signal.aborted && !externalSignal?.aborted
					? new HttpTimeoutError(timeout, { cause: error })
					: (error as Error);
			if (externalSignal?.aborted) throw lastError;

			if (attempt < attempts && isRetryableError(lastError)) {
				const delay = 2 ** (attempt - 1) * 500;
				logger.warn(
					`[http] attempt ${attempt}/${attempts} failed: ${lastError.message}, retry in ${delay}ms`,
				);
				await sleep(delay);
				continue;
			}

			throw lastError;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	throw lastError;
}
