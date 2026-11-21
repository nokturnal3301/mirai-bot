import type { TelegramUser } from "gramio";
import type { MembershipContext, MessageContext } from "bot/types";

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
import { chatLabel } from "bot/telegram";

export const startHandler = (info: TelegramUser) => {
	logger.success(`started as @${info.username}`);
};

export const errorHandler = (kind: string, error: Error) => {
	logger.error(`[${kind}]`, error.message);
};

const isPresent = (status: string): boolean =>
	status !== "left" && status !== "kicked";

// Telegram reports every change of the bot's own place in a chat. A private
// chat changes when a person blocks or unblocks the bot, which is not logged.
export const membershipHandler = (ctx: MembershipContext) => {
	if (ctx.chat.type === "private") return;

	const { status } = ctx.newChatMember;
	const change = !isPresent(status)
		? "removed from"
		: isPresent(ctx.oldChatMember.status)
			? `now ${status} in`
			: "added to";
	logger.info(`[chat] ${change} ${chatLabel(ctx.chat)}`);
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
