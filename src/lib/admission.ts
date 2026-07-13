import { createSemaphore } from "./concurrency";

const cpu = createSemaphore(1);

export const withCpuAdmission = <T>(
	run: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> => cpu.withPermit(run, signal);
