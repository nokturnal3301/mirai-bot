import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "config";
import { createSemaphore } from "./concurrency";
import { isResponseTooLargeFailure, responseTooLargeFailure } from "./errors";
import { readResponseBytes } from "./http";
import { logger } from "./logger";
import { downloadInRanges } from "./ranged-download";
import { assertPublicHttpUrl } from "./url";

type MuxOptions = {
	videoUrl: string;
	audioUrl: string;
	headers?: Record<string, string>;
	timeout?: number;
	signal?: AbortSignal;
	videoCodecCompatible?: boolean;
};

const CONNECTIONS_VIDEO = 6;
const CONNECTIONS_AUDIO = 2;
const muxSemaphore = createSemaphore(2);

const MAX_STDERR_BYTES = 64 * 1024;

const readTail = async (
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<string> => {
	const reader = stream.getReader();
	let tail = new Uint8Array();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const fromValue = Math.min(value.length, maxBytes);
			const fromTail = Math.min(tail.length, maxBytes - fromValue);
			const next = new Uint8Array(fromTail + fromValue);
			next.set(tail.subarray(tail.length - fromTail), 0);
			next.set(value.subarray(value.length - fromValue), fromTail);
			tail = next;
		}
	} finally {
		reader.releaseLock();
	}

	return new TextDecoder().decode(tail);
};

const settleSiblingsOnFailure = async <T>(
	operations: readonly Promise<T>[],
	abort: (reason: unknown) => void,
): Promise<T[]> => {
	try {
		return await Promise.all(operations);
	} catch (error) {
		abort(error);
		await Promise.allSettled(operations);
		throw error;
	}
};

const muxWithPermit = async (
	options: MuxOptions,
	controller: AbortController,
): Promise<Blob | null> => {
	const { videoUrl, audioUrl, headers = {}, videoCodecCompatible } = options;

	const id = randomBytes(8).toString("hex");
	const videoPath = join(tmpdir(), `mux-v-${id}`);
	const audioPath = join(tmpdir(), `mux-a-${id}`);

	const videoCodecArgs = videoCodecCompatible
		? ["-c:v", "copy"]
		: [
				"-c:v",
				"libx264",
				"-preset",
				"veryfast",
				"-crf",
				"23",
				"-pix_fmt",
				"yuv420p",
				"-profile:v",
				"main",
				"-level:v",
				"4.0",
			];

	const t0 = performance.now();
	let inputBytes = 0;
	const takeInputBytes = (bytes: number): void => {
		inputBytes += bytes;
		if (inputBytes > config.telegram.maxFileSize) {
			throw responseTooLargeFailure(config.telegram.maxFileSize, inputBytes);
		}
	};

	try {
		const downloads = [
			downloadInRanges(videoUrl, {
				headers,
				connections: CONNECTIONS_VIDEO,
				maxBytes: config.telegram.maxFileSize,
				label: "video",
				signal: controller.signal,
				onBytes: takeInputBytes,
			}),
			downloadInRanges(audioUrl, {
				headers,
				connections: CONNECTIONS_AUDIO,
				maxBytes: config.telegram.maxFileSize,
				label: "audio",
				signal: controller.signal,
				onBytes: takeInputBytes,
			}),
		];
		const buffers = await settleSiblingsOnFailure(downloads, (reason) =>
			controller.abort(reason),
		);
		const videoBuf = buffers[0]?.bytes;
		const audioBuf = buffers[1]?.bytes;
		if (!videoBuf || !audioBuf) throw new Error("missing mux input");
		const writes = [
			Bun.write(videoPath, videoBuf),
			Bun.write(audioPath, audioBuf),
		];
		await settleSiblingsOnFailure(writes, (reason) => controller.abort(reason));
		const downloadMs = (performance.now() - t0).toFixed(0);
		logger.info(
			`[ffmpeg] downloads done in ${downloadMs}ms, muxing (${videoCodecCompatible ? "copy" : "transcode"})...`,
		);

		const args = [
			"-y",
			"-loglevel",
			"error",
			"-i",
			videoPath,
			"-i",
			audioPath,
			"-map",
			"0:v:0",
			"-map",
			"1:a:0",
			...videoCodecArgs,
			"-c:a",
			"copy",
			"-movflags",
			"frag_keyframe+empty_moov+default_base_moof",
			"-f",
			"mp4",
			"pipe:1",
		];

		const subprocess = Bun.spawn(["ffmpeg", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const killOnAbort = () => {
			try {
				subprocess.kill();
			} catch {}
		};
		controller.signal.addEventListener("abort", killOnAbort, { once: true });
		try {
			const outputTask = readResponseBytes(
				new Response(subprocess.stdout as ReadableStream<Uint8Array>),
				config.telegram.maxFileSize,
			);
			const stderrTask = readTail(
				subprocess.stderr as ReadableStream<Uint8Array>,
				MAX_STDERR_BYTES,
			);
			const exitTask = subprocess.exited;

			let output: Uint8Array;
			let stderrOutput: string;
			let exitCode: number;
			try {
				[output, stderrOutput, exitCode] = await Promise.all([
					outputTask,
					stderrTask,
					exitTask,
				]);
			} catch (error) {
				if (!controller.signal.aborted) controller.abort(error);
				await Promise.allSettled([outputTask, stderrTask, exitTask]);
				throw error;
			}

			if (exitCode !== 0) {
				logger.error(`[ffmpeg] failed with code ${exitCode}`);
				logger.error(`[ffmpeg] ${stderrOutput.slice(-500)}`);
				return null;
			}
			const sizeMB = (output.byteLength / 1024 / 1024).toFixed(2);
			const total = (performance.now() - t0).toFixed(0);
			logger.info(`[ffmpeg] done: ${sizeMB}MB in ${total}ms total`);

			return new Blob([output.buffer as ArrayBuffer], { type: "video/mp4" });
		} finally {
			controller.signal.removeEventListener("abort", killOnAbort);
		}
	} catch (error) {
		if (!controller.signal.aborted) controller.abort(error);
		if (isResponseTooLargeFailure(error)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`[ffmpeg] error: ${message}`);
		return null;
	} finally {
		await Promise.all([
			unlink(videoPath).catch(() => {}),
			unlink(audioPath).catch(() => {}),
		]);
	}
};

export const mux = async (options: MuxOptions): Promise<Blob | null> => {
	assertPublicHttpUrl(options.videoUrl);
	assertPublicHttpUrl(options.audioUrl);

	const controller = new AbortController();
	const abortFromParent = () => controller.abort(options.signal?.reason);
	if (options.signal?.aborted) abortFromParent();
	else
		options.signal?.addEventListener("abort", abortFromParent, { once: true });
	const timeoutId = setTimeout(
		() => controller.abort("mux deadline exceeded"),
		options.timeout ?? config.ffmpeg.timeout,
	);

	try {
		return await muxSemaphore.withPermit(
			() => muxWithPermit(options, controller),
			controller.signal,
		);
	} catch (error) {
		if (isResponseTooLargeFailure(error)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`[ffmpeg] error: ${message}`);
		return null;
	} finally {
		clearTimeout(timeoutId);
		options.signal?.removeEventListener("abort", abortFromParent);
	}
};
