import { describe, expect, test } from "bun:test";
import { resolveProxyUrl } from "lib/http-context";

describe("resolveProxyUrl", () => {
	test("adds country targeting before the sticky session", () => {
		const resolved = new URL(
			resolveProxyUrl(
				"http://customer:secret@geo.iproyal.com:12321",
				"abc123",
				"UA",
			),
		);

		expect(resolved.hostname).toBe("geo.iproyal.com");
		expect(decodeURIComponent(resolved.password)).toBe(
			"secret_country-ua_session-abc123_lifetime-10m",
		);
	});
});
