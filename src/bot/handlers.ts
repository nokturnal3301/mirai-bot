import type { TelegramUser } from "gramio";
import type { MessageContext } from "bot/types";

import { logger, trackTask, withDownloadSlot, withRequestId } from "lib";
import { F, chain } from "lib/flow";
import {
	logMessage,
	detectLinks,
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

const inRequest = <T>(run: () => Promise<T>): Promise<T> =>
	withRequestId(() => withDownloadSlot(run));

export const messageHandler = (ctx: MessageContext) =>
	trackTask(async () => {
		if (!ctx.text && !ctx.caption) return;
		if (!ctx.from) return;

		await inRequest(() =>
			chain(F.of({ ctx }))
				.pipe(logMessage)
				.pipe(detectLinks)
				.pipe(matchExtractor)
				.pipe(checkRateLimit)
				.pipe(extract)
				.pipe(checkFileSize)
				.pipe(sendMedia)
				.recover(replyError(ctx))
				.run(),
		);
	});
