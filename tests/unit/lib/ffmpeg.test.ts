import { describe, expect, spyOn, test } from "bun:test";
import { mux } from "lib/ffmpeg";

const VIDEO_URL = "https://media.example/video";
const AUDIO_URL = "https://media.example/audio";

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});

const mediaFetch = async (
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> => {
	const url = String(input);
	const bytes =
		url === VIDEO_URL ? new Uint8Array([1, 2, 3]) : new Uint8Array([4]);
	const range = new Headers(init?.headers).get("range");
	if (range === "bytes=0-0") {
		return new Response(bytes.subarray(0, 1), {
			status: 206,
			headers: { "Content-Range": `bytes 0-0/${bytes.length}` },
		});
	}
	return new Response(bytes);
};

const fakeProcess = (
	stdout: ReadableStream<Uint8Array>,
	stderr: ReadableStream<Uint8Array> = streamOf(new Uint8Array()),
) =>
	({
		stdout,
		stderr,
		exited: Promise.resolve(0),
		kill: () => {},
	}) as unknown as ReturnType<typeof Bun.spawn>;

describe("ffmpeg mux", () => {
	test("downloads both inputs and returns bounded process output", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			mediaFetch as typeof fetch,
		);
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
			fakeProcess(streamOf(new Uint8Array([9, 8, 7]))),
		);

		try {
			const result = await mux({
				videoUrl: VIDEO_URL,
				audioUrl: AUDIO_URL,
				videoCodecCompatible: true,
			});

			expect(result).toBeInstanceOf(Blob);
			expect(result?.size).toBe(3);
			expect(fetchSpy).toHaveBeenCalledTimes(4);
			expect(spawnSpy).toHaveBeenCalledTimes(1);
		} finally {
			fetchSpy.mockRestore();
			spawnSpy.mockRestore();
		}
	});

	test("rejects a redirect to a private network before following it", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async () =>
				new Response(null, {
					status: 302,
					headers: { Location: "http://127.0.0.1/internal" },
				})) as unknown as typeof fetch,
		);
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
			fakeProcess(streamOf(new Uint8Array())),
		);

		try {
			const result = await mux({
				videoUrl: VIDEO_URL,
				audioUrl: AUDIO_URL,
				videoCodecCompatible: true,
			});

			expect(result).toBeNull();
			expect(fetchSpy).toHaveBeenCalledTimes(2);
			expect(spawnSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
			spawnSpy.mockRestore();
		}
	});

	test("aborts the sibling download when one input fails", async () => {
		let audioAborted = false;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			if (String(input) === VIDEO_URL) {
				return new Response(new Uint8Array([1]), {
					status: 206,
					headers: { "Content-Range": "invalid" },
				});
			}

			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => {
						audioAborted = true;
						reject(init.signal?.reason);
					},
					{ once: true },
				);
			});
		}) as typeof fetch);
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
			fakeProcess(streamOf(new Uint8Array())),
		);

		try {
			const result = await mux({
				videoUrl: VIDEO_URL,
				audioUrl: AUDIO_URL,
				videoCodecCompatible: true,
			});

			expect(result).toBeNull();
			expect(audioAborted).toBe(true);
			expect(spawnSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
			spawnSpy.mockRestore();
		}
	});

	test("kills and awaits ffmpeg when stdout reading fails", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			mediaFetch as typeof fetch,
		);
		let resolveExit: (code: number) => void = () => {};
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		let kills = 0;
		const stdout = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error("stdout failed"));
			},
		});
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
			stdout,
			stderr: streamOf(new Uint8Array()),
			exited,
			kill: () => {
				kills++;
				resolveExit(1);
			},
		} as unknown as ReturnType<typeof Bun.spawn>);

		try {
			const result = await mux({
				videoUrl: VIDEO_URL,
				audioUrl: AUDIO_URL,
				videoCodecCompatible: true,
			});

			expect(result).toBeNull();
			expect(kills).toBe(1);
		} finally {
			fetchSpy.mockRestore();
			spawnSpy.mockRestore();
		}
	});
});
