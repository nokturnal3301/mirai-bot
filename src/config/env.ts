import { z } from "zod";

const envSchema = z.object({
	TELEGRAM_BOT_TOKEN: z.string().min(1),
	PROXY_URL: z
		.string()
		.optional()
		.refine(
			(value) => !value || /^https?:\/\//.test(value),
			"PROXY_URL must be http(s)://",
		),
	REDIS_URL: z
		.string()
		.optional()
		.refine(
			(value) => !value || /^rediss?:\/\//.test(value),
			"REDIS_URL must be redis(s)://",
		),
});

export const env = envSchema.parse(process.env);
