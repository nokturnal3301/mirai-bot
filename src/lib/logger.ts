import { AsyncLocalStorage } from "node:async_hooks";
import { createConsola } from "consola";

const consola = createConsola({
	formatOptions: {
		date: true,
		colors: true,
	},
});

type Level = "info" | "warn" | "error" | "success";

const requests = new AsyncLocalStorage<string>();
let lastRequest = 0;

// Requests run at the same time and their lines interleave; every line written
// inside one carries its number, so `grep "#42 "` shows a single request.
export const withRequestId = <T>(run: () => Promise<T>): Promise<T> =>
	requests.run(`#${++lastRequest}`, run);

const write =
	(level: Level) =>
	(message: unknown, ...rest: unknown[]): void => {
		const id = requests.getStore();
		if (id) consola[level](id, message, ...rest);
		else consola[level](message, ...rest);
	};

export const logger = {
	info: write("info"),
	warn: write("warn"),
	error: write("error"),
	success: write("success"),
};
