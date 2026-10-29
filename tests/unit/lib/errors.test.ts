import { describe, expect, test } from "bun:test";
import {
	extractionError,
	extractionErrorFrom,
	HttpNetworkError,
	HttpStatusError,
	HttpTimeoutError,
	responseTooLargeFailure,
} from "lib/errors";

describe("ExtractionError", () => {
	test("marks oversized media as terminal and non-retryable", () => {
		const error = extractionError("MEDIA_TOO_LARGE", "FILE_TOO_LARGE");
		expect(error).toMatchObject({ terminal: true, retryable: false });
	});

	test("does not infer control flow from an untyped error message", () => {
		const error = extractionErrorFrom(new Error("schema download no media"));
		expect(error).toMatchObject({ code: "UNKNOWN", retryable: false });
	});

	test("rejects malformed error-like objects", () => {
		const error = extractionErrorFrom({
			code: "MADE_UP",
			message: "bad contract",
			retryable: true,
			terminal: false,
		});

		expect(error).toMatchObject({ code: "UNKNOWN", retryable: false });
	});

	test("preserves an already typed error", () => {
		const expected = extractionError("UPSTREAM_REJECTED", "login wall");
		expect(extractionErrorFrom(expected)).toBe(expected);
	});

	test("keeps response size details", () => {
		const error = extractionErrorFrom(responseTooLargeFailure(50, 80));
		expect(error).toMatchObject({
			code: "MEDIA_TOO_LARGE",
			details: { actualBytes: 80, limitBytes: 50 },
		});
	});

	test("classifies an HTTP deadline as a retryable upstream failure", () => {
		const error = extractionErrorFrom(new HttpTimeoutError(100));
		expect(error).toMatchObject({
			code: "UPSTREAM_REJECTED",
			retryable: true,
			terminal: false,
		});
	});

	test("classifies a network failure as a retryable upstream failure", () => {
		const error = extractionErrorFrom(
			new HttpNetworkError("https://example.com/resource", {
				cause: new Error("Proxy refused to open a tunnel: 504 Gateway Timeout"),
			}),
		);

		expect(error).toMatchObject({
			code: "UPSTREAM_REJECTED",
			message: "Proxy refused to open a tunnel: 504 Gateway Timeout",
			retryable: true,
			terminal: false,
			details: { url: "https://example.com/resource" },
		});
	});

	test("preserves an HTTP status as structured details", () => {
		const forbidden = extractionErrorFrom(
			new HttpStatusError(403, "https://example.com/resource"),
		);
		const missing = extractionErrorFrom(
			new HttpStatusError(404, "https://example.com/missing"),
		);

		expect(forbidden).toMatchObject({
			code: "UPSTREAM_REJECTED",
			retryable: true,
			details: { status: 403 },
		});
		expect(missing).toMatchObject({ retryable: false });
	});
});
