import { logger } from "./logger";

type CleanupFunction = () => Promise<void> | void;
const activeTasks = new Set<Promise<unknown>>();

export const trackTask = <T>(run: () => Promise<T>): Promise<T> => {
	const task = run();
	activeTasks.add(task);
	void task.finally(() => activeTasks.delete(task)).catch(() => {});
	return task;
};

export const drainTasks = async (timeoutMs: number): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	while (activeTasks.size > 0) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;

		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const drained = await Promise.race([
			Promise.allSettled([...activeTasks]).then(() => true),
			new Promise<false>((resolve) => {
				timeoutId = setTimeout(() => resolve(false), remaining);
			}),
		]);
		if (timeoutId) clearTimeout(timeoutId);
		if (!drained) return false;
	}
	return true;
};

export const setupGracefulShutdown = (cleanup: CleanupFunction) => {
	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info(`Received ${signal}, shutting down...`);
		try {
			await cleanup();
			logger.success("Stopped gracefully");
			process.exit(0);
		} catch (error) {
			logger.error(
				`Shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(1);
		}
	};

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
};
