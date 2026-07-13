import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export type HttpContext = {
	forceProxy: boolean;
	proxySession?: string;
};

const storage = new AsyncLocalStorage<HttpContext>();

export const withHttpContext = <T>(
	context: HttpContext,
	fn: () => Promise<T>,
): Promise<T> => storage.run(context, fn);

export const getHttpContext = (): HttpContext | undefined => storage.getStore();

export const withStickyProxy = <T>(fn: () => Promise<T>): Promise<T> =>
	withHttpContext(
		{ forceProxy: true, proxySession: randomBytes(6).toString("hex") },
		fn,
	);

export const resolveProxyUrl = (
	base: string,
	session: string | undefined,
): string => {
	if (!session) return base;
	try {
		const url = new URL(base);
		const rawPassword = decodeURIComponent(url.password);
		url.password = `${rawPassword}_session-${session}_lifetime-10m`;
		return url.toString();
	} catch {
		return base;
	}
};
