import { describe, expect, spyOn, test } from "bun:test";
import { downloadInRanges } from "lib/ranged-download";

const URL = "https://media.example/video";

describe("ranged download", () => {
	test.each([
		200, 206,
	])("keeps the deadline active through a stalled %i body", async (status) => {
		let aborted = false;
		const parent = new AbortController();
		const guard = setTimeout(() => parent.abort("test guard expired"), 500);
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			_input,
			init,
		) => {
			const range = new Headers(init?.headers).get("range");
			if (status === 206 && range === "bytes=0-0") {
				return new Response(new Uint8Array([1]), {
					status: 206,
					headers: { "Content-Range": "bytes 0-0/3" },
				});
			}
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array([1]));
						init?.signal?.addEventListener(
							"abort",
							() => {
								aborted = true;
								controller.error(new Error(String(init.signal?.reason)));
							},
							{ once: true },
						);
					},
				}),
				{ status },
			);
		}) as typeof fetch);

		try {
			await expect(
				downloadInRanges(URL, {
					connections: 2,
					maxBytes: 1024,
					label: "stalled-video",
					timeout: 20,
					signal: parent.signal,
				}),
			).rejects.toThrow(/download (?:too slow|deadline exceeded)/);
			expect(aborted).toBe(true);
			expect(parent.signal.aborted).toBe(false);
		} finally {
			clearTimeout(guard);
			parent.abort("test cleanup");
			fetchSpy.mockRestore();
		}
	});

	test("downloads ranges concurrently and assembles them in order", async () => {
		const source = Uint8Array.from(
			{ length: 600 * 1024 },
			(_, index) => index % 251,
		);
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			_input,
			init,
		) => {
			const range = new Headers(init?.headers).get("range");
			if (range === "bytes=0-0") {
				return new Response(source.subarray(0, 1), {
					status: 206,
					headers: {
						"Content-Range": `bytes 0-0/${source.length}`,
						"Content-Type": "video/mp4",
					},
				});
			}

			const match = range?.match(/^bytes=(\d+)-(\d+)$/);
			const start = Number(match?.[1]);
			const end = Number(match?.[2]);
			return new Response(source.slice(start, end + 1), {
				status: 206,
				headers: {
					"Content-Range": `bytes ${start}-${end}/${source.length}`,
					"Content-Type": "video/mp4",
				},
			});
		}) as typeof fetch);

		try {
			const result = await downloadInRanges(URL, {
				connections: 4,
				expectedBytes: source.length,
				maxBytes: 1024 * 1024,
				label: "test-video",
			});

			expect(fetchSpy).toHaveBeenCalledTimes(4);
			expect(result.contentType).toBe("video/mp4");
			expect(result.bytes).toEqual(source);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("fails a range that sends more bytes than it announced", async () => {
		const total = 600 * 1024;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			_input,
			init,
		) => {
			const match = new Headers(init?.headers)
				.get("range")
				?.match(/^bytes=(\d+)-(\d+)$/);
			const start = Number(match?.[1]);
			const end = Number(match?.[2]);
			return new Response(new Uint8Array(end - start + 2), {
				status: 206,
				headers: { "Content-Range": `bytes ${start}-${end}/${total}` },
			});
		}) as typeof fetch);

		try {
			await expect(
				downloadInRanges(URL, {
					connections: 2,
					expectedBytes: total,
					maxBytes: 1024 * 1024,
					label: "long-range",
				}),
			).rejects.toThrow("longer than expected");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("reuses a full response when the server ignores Range", async () => {
		const source = new Uint8Array([1, 2, 3]);
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(source, { headers: { "Content-Type": "video/mp4" } }),
		);

		try {
			const result = await downloadInRanges(URL, {
				connections: 6,
				maxBytes: 1024,
				label: "test-video",
			});

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(result.bytes).toEqual(source);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("keeps a bounded Range request for a small source", async () => {
		const source = new Uint8Array([1, 2, 3]);
		const ranges: (string | null)[] = [];
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			_input,
			init,
		) => {
			const range = new Headers(init?.headers).get("range");
			ranges.push(range);
			if (range === "bytes=0-0") {
				return new Response(source.subarray(0, 1), {
					status: 206,
					headers: { "Content-Range": `bytes 0-0/${source.length}` },
				});
			}
			return new Response(source, {
				status: 206,
				headers: { "Content-Range": `bytes 0-2/${source.length}` },
			});
		}) as typeof fetch);

		try {
			const result = await downloadInRanges(URL, {
				connections: 2,
				maxBytes: 1024,
				label: "test-audio",
			});

			expect(ranges).toEqual(["bytes=0-0", "bytes=0-2"]);
			expect(result.bytes).toEqual(source);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
