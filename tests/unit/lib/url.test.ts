import { describe, test, expect } from "bun:test";
import { findUrls, isPublicHttpUrl, matchesHttpUrl } from "lib/url";

describe("findUrls", () => {
	test("extracts an https URL from text", () => {
		const text = "Check this out https://instagram.com/p/abc123 amazing!";
		expect(findUrls(text)).toEqual(["https://instagram.com/p/abc123"]);
	});

	test("extracts an http URL from text", () => {
		expect(findUrls("Link: http://example.com/page")).toEqual([
			"http://example.com/page",
		]);
	});

	test("returns every URL in the order they appear", () => {
		expect(findUrls("https://first.com and https://second.com")).toEqual([
			"https://first.com",
			"https://second.com",
		]);
	});

	test("returns nothing when no URL is present", () => {
		expect(findUrls("No links here")).toEqual([]);
	});

	test("keeps the query string and drops trailing punctuation", () => {
		expect(findUrls("See (https://youtube.com/watch?v=abc), ok?")).toEqual([
			"https://youtube.com/watch?v=abc",
		]);
	});
});

describe("isPublicHttpUrl", () => {
	test("accepts public https URL", () => {
		expect(isPublicHttpUrl("https://example.com/path")).toBe(true);
	});

	test("accepts public http URL", () => {
		expect(isPublicHttpUrl("http://example.com")).toBe(true);
	});

	test("rejects non-http protocols", () => {
		expect(isPublicHttpUrl("ftp://example.com")).toBe(false);
		expect(isPublicHttpUrl("file:///etc/passwd")).toBe(false);
	});

	test("rejects localhost", () => {
		expect(isPublicHttpUrl("http://localhost:3000")).toBe(false);
	});

	test("rejects 127.0.0.1", () => {
		expect(isPublicHttpUrl("http://127.0.0.1:3000")).toBe(false);
	});

	test("rejects 10.x private range", () => {
		expect(isPublicHttpUrl("http://10.0.0.1/")).toBe(false);
	});

	test("rejects 192.168.x private range", () => {
		expect(isPublicHttpUrl("http://192.168.1.1/")).toBe(false);
	});

	test("rejects 172.16-31 private range", () => {
		expect(isPublicHttpUrl("http://172.20.0.1/")).toBe(false);
	});

	test("rejects IPv6 loopback", () => {
		expect(isPublicHttpUrl("http://[::1]/")).toBe(false);
	});

	test("rejects private and mapped IPv6 ranges", () => {
		expect(isPublicHttpUrl("http://[fd00::1]/")).toBe(false);
		expect(isPublicHttpUrl("http://[fe90::1]/")).toBe(false);
		expect(isPublicHttpUrl("http://[::ffff:127.0.0.1]/")).toBe(false);
	});

	test("normalizes a trailing hostname dot", () => {
		expect(isPublicHttpUrl("http://localhost./")).toBe(false);
	});

	test("rejects malformed URLs", () => {
		expect(isPublicHttpUrl("not a url")).toBe(false);
	});
});

describe("matchesHttpUrl", () => {
	test("matches an allowlisted domain and path", () => {
		expect(
			matchesHttpUrl(
				"https://www.tiktok.com/@user/video/123",
				["tiktok.com"],
				/^\/@[^/]+\/video\/\d+/,
			),
		).toBe(true);
	});

	test("does not accept a domain name embedded in a path", () => {
		expect(
			matchesHttpUrl(
				"http://[fd00::1]/tiktok.com/@user/video/123",
				["tiktok.com"],
				/^\/@[^/]+\/video\/\d+/,
			),
		).toBe(false);
	});

	test("does not accept a lookalike suffix", () => {
		expect(
			matchesHttpUrl(
				"https://tiktok.com.evil.test/@user/video/123",
				["tiktok.com"],
				/^\/@[^/]+\/video\/\d+/,
			),
		).toBe(false);
	});
});
