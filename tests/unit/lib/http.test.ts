import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { HttpStatusError, HttpTimeoutError } from "lib/errors";
import { http } from "lib/http";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let largeRequests = 0;
let forbiddenRequests = 0;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);

			if (url.pathname === "/json") {
				return Response.json({ message: "hello", count: 42 });
			}

			if (url.pathname === "/text") {
				return new Response("plain text response");
			}

			if (url.pathname === "/blob") {
				return new Response(new Blob(["binary data"]));
			}

			if (url.pathname === "/large") {
				largeRequests++;
				return new Response("response exceeds limit");
			}

			if (url.pathname === "/error") {
				return new Response("Not Found", { status: 404 });
			}

			if (url.pathname === "/forbidden") {
				forbiddenRequests++;
				return new Response("Forbidden", { status: 403 });
			}

			if (url.pathname === "/slow") {
				return new Promise((resolve) => {
					setTimeout(() => {
						resolve(Response.json({ slow: true }));
					}, 2000);
				});
			}

			if (url.pathname === "/slow-body") {
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("start"));
							setTimeout(() => {
								try {
									controller.enqueue(new TextEncoder().encode("end"));
									controller.close();
								} catch {
									// The client deadline already cancelled the body.
								}
							}, 2_000);
						},
					}),
					{ headers: { "Content-Type": "text/plain" } },
				);
			}

			if (url.pathname === "/redirect") {
				return Response.redirect(`${baseUrl}/text`, 302);
			}

			return new Response("OK");
		},
	});

	baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server.stop();
});

describe("http", () => {
	test("fetches JSON response", async () => {
		const result = await http<{ message: string; count: number }>(
			`${baseUrl}/json`,
			{ allowPrivate: true },
		);

		expect(result.message).toBe("hello");
		expect(result.count).toBe(42);
	});

	test("fetches text response", async () => {
		const result = await http(`${baseUrl}/text`, {
			responseType: "text",
			allowPrivate: true,
		});

		expect(result).toBe("plain text response");
	});

	test("fetches blob response", async () => {
		const result = await http(`${baseUrl}/blob`, {
			responseType: "blob",
			allowPrivate: true,
		});

		expect(result).toBeInstanceOf(Blob);
		expect(result.size).toBeGreaterThan(0);
	});

	test("rejects oversized blobs before retrying", async () => {
		largeRequests = 0;
		await expect(
			http(`${baseUrl}/large`, {
				responseType: "blob",
				maxBytes: 5,
				attempts: 3,
				allowPrivate: true,
			}),
		).rejects.toThrow("FILE_TOO_LARGE");
		expect(largeRequests).toBe(1);
	});

	test("fetches raw response", async () => {
		const result = await http(`${baseUrl}/json`, {
			responseType: "raw",
			allowPrivate: true,
		});

		expect(result).toBeInstanceOf(Response);
		expect(result.ok).toBe(true);
	});

	test("reads text and headers under the same deadline", async () => {
		const result = await http(`${baseUrl}/text`, {
			responseType: "textWithHeaders",
			allowPrivate: true,
		});

		expect(result.body).toBe("plain text response");
		expect(result.status).toBe(200);
	});

	test("keeps the deadline active while reading a response body", async () => {
		await expect(
			http(`${baseUrl}/slow-body`, {
				responseType: "textWithHeaders",
				timeout: 50,
				attempts: 1,
				allowPrivate: true,
			}),
		).rejects.toBeInstanceOf(HttpTimeoutError);
	});

	test("follows redirects through the checked redirect loop", async () => {
		const result = await http(`${baseUrl}/redirect`, {
			responseType: "text",
			allowPrivate: true,
		});

		expect(result).toBe("plain text response");
	});

	test("preserves explicit manual redirects", async () => {
		const result = await http(`${baseUrl}/redirect`, {
			responseType: "raw",
			redirect: "manual",
			allowPrivate: true,
		});

		expect(result.status).toBe(302);
		expect(result.headers.get("location")).toBe(`${baseUrl}/text`);
	});

	test("checks final status for non-redirect raw requests", async () => {
		await expect(
			http(`${baseUrl}/error`, {
				responseType: "raw",
				attempts: 1,
				allowPrivate: true,
			}),
		).rejects.toThrow("HTTP 404");
	});

	test("throws a structured HTTP status error", async () => {
		try {
			await http(`${baseUrl}/error`, { allowPrivate: true, attempts: 1 });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(HttpStatusError);
			expect(error).toMatchObject({ status: 404, url: `${baseUrl}/error` });
		}
	});

	test("does not retry an auth block on the same route", async () => {
		forbiddenRequests = 0;
		await expect(
			http(`${baseUrl}/forbidden`, { allowPrivate: true, attempts: 3 }),
		).rejects.toBeInstanceOf(HttpStatusError);
		expect(forbiddenRequests).toBe(1);
	});

	test("respects timeout", async () => {
		await expect(
			http(`${baseUrl}/slow`, {
				timeout: 100,
				attempts: 1,
				allowPrivate: true,
			}),
		).rejects.toBeInstanceOf(HttpTimeoutError);
	});

	test("passes custom headers", async () => {
		const result = await http(`${baseUrl}/json`, {
			headers: { "X-Custom": "value" },
			allowPrivate: true,
		});

		expect(result).toBeDefined();
	});

	test("rejects private URLs without opt-in", async () => {
		await expect(http(`${baseUrl}/json`)).rejects.toThrow(/unsafe URL/);
	});
});
