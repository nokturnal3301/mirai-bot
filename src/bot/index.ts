import { Bot } from "gramio";

import { config, env } from "config";
import { closeCache, drainTasks, logger, setupGracefulShutdown } from "lib";
import { startHandler, errorHandler, messageHandler } from "bot/handlers";
import { startCommand, helpCommand } from "bot/commands";

const bot = new Bot(env.TELEGRAM_BOT_TOKEN, {
	api: {
		// GramIO spreads these into every request, so each call gets a fresh deadline.
		fetchOptions: {
			get signal() {
				return AbortSignal.timeout(config.telegram.requestTimeout);
			},
		},
	},
})
	.onStart(({ info }) => startHandler(info))
	.command("start", startCommand)
	.command("help", helpCommand)
	.on("message", messageHandler)
	.onError(({ kind, error }) => errorHandler(kind, error));

setupGracefulShutdown(async () => {
	try {
		await bot.stop();
		const drained = await drainTasks(config.shutdown.drainTimeout);
		if (!drained) logger.warn("Shutdown drain deadline exceeded");
	} finally {
		closeCache();
	}
});

await bot.api.setMyCommands({
	commands: [
		{ command: "start", description: "Start the bot" },
		{ command: "help", description: "How to use" },
	],
});

await bot.start();
