import type { MessageContext } from "bot/types";
import { MESSAGES } from "bot/constants";

export const startCommand = async (ctx: MessageContext) => {
	await ctx.reply(MESSAGES.WELCOME);
};

export const helpCommand = async (ctx: MessageContext) => {
	await ctx.reply(MESSAGES.HELP);
};
