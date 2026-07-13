import { describe, test, expect } from "bun:test";
import { findExtractor } from "extractors/registry";

describe("extractor registry", () => {
	test("all platforms have registered extractors", () => {
		const urls = [
			{ url: "https://instagram.com/p/ABC123", platform: "instagram" },
			{ url: "https://youtube.com/shorts/ABC123", platform: "youtube" },
			{ url: "https://tiktok.com/@user/video/123", platform: "tiktok" },
			{ url: "https://vm.tiktok.com/ABC123", platform: "tiktok" },
			{
				url: "https://www.threads.com/@user/post/ABC123",
				platform: "threads",
			},
			{ url: "https://twitter.com/user/status/123", platform: "twitter" },
			{ url: "https://x.com/user/status/123", platform: "twitter" },
			{
				url: "https://reddit.com/r/sub/comments/abc/title",
				platform: "reddit",
			},
			{ url: "https://redd.it/abc", platform: "reddit" },
			{ url: "https://v.redd.it/abcdef", platform: "reddit" },
		] as const;

		for (const { url, platform } of urls) {
			const extractor = findExtractor(url);
			expect(extractor).toBeDefined();
			expect(extractor?.platform).toBe(platform);
		}
	});

	test("extractors have required methods", () => {
		const extractor = findExtractor("https://instagram.com/p/ABC");

		expect(extractor).toBeDefined();
		expect(typeof extractor?.match).toBe("function");
		expect(typeof extractor?.extract).toBe("function");
		expect(typeof extractor?.platform).toBe("string");
	});

	test("returns undefined for unsupported URL", () => {
		const extractor = findExtractor("https://facebook.com/user/posts/123");
		expect(extractor).toBeUndefined();
	});

	test("does not route a supported domain embedded in another URL", () => {
		expect(
			findExtractor("http://[fd00::1]/tiktok.com/@user/video/123"),
		).toBeUndefined();
		expect(
			findExtractor("https://evil.test/instagram.com/reel/ABC123"),
		).toBeUndefined();
	});
});
