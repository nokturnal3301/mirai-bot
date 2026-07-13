import type { TelegramUser } from "gramio";
import type { MessageContext } from "bot/types";

import { logger, trackTask } from "lib";
import { F, chain } from "lib/flow";
import {
	logMessage,
	detectUrl,
	matchExtractor,
	checkRateLimit,
	extract,
	checkFileSize,
	sendMedia,
	replyError,
} from "bot/transforms";

export const startHandler = (info: TelegramUser) => {
	logger.success(`started as @${info.username}`);
};

export const errorHandler = (kind: string, error: Error) => {
	logger.error(`[${kind}]`, error.message);
};

export const messageHandler = (ctx: MessageContext) =>
	trackTask(async () => {
		if (!ctx.text) return;
		if (!ctx.from) return;

		await chain(F.of({ ctx }))
			.pipe(logMessage)
			.pipe(detectUrl)
			.pipe(matchExtractor)
			.pipe(checkRateLimit)
			.pipe(extract)
			.pipe(checkFileSize)
			.pipe(sendMedia)
			.recover(replyError(ctx))
			.run();
	});
