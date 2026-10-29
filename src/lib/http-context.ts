import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export type HttpContext = {
	forceProxy: boolean;
	proxySession?: string;
	proxyCountry?: string;
};

const storage = new AsyncLocalStorage<HttpContext>();

export const withHttpContext = <T>(
	context: HttpContext,
	fn: () => Promise<T>,
): Promise<T> => storage.run(context, fn);

export const getHttpContext = (): HttpContext | undefined => storage.getStore();

export const withStickyProxy = <T>(
	fn: () => Promise<T>,
	options: { country?: string } = {},
): Promise<T> =>
	withHttpContext(
		{
			forceProxy: true,
			proxySession: randomBytes(6).toString("hex"),
			...(options.country ? { proxyCountry: options.country } : {}),
		},
		fn,
	);

export const resolveProxyUrl = (
	base: string,
	session: string | undefined,
	country?: string,
): string => {
	const normalizedCountry = country?.trim().toLowerCase();
	const countryOption = normalizedCountry?.match(/^[a-z]{2}$/)
		? `_country-${normalizedCountry}`
		: "";
	if (!session && !countryOption) return base;
	try {
		const url = new URL(base);
		const rawPassword = decodeURIComponent(url.password);
		const sessionOption = session ? `_session-${session}_lifetime-10m` : "";
		url.password = `${rawPassword}${countryOption}${sessionOption}`;
		return url.toString();
	} catch {
		return base;
	}
};
