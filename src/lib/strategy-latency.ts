export type AdaptiveDelay = Readonly<{
	kind: "adaptive";
	strategy: string;
	percentile: number;
	min: number;
	max: number;
	fallback: number;
}>;

export type StrategyDelay = number | AdaptiveDelay;

const MAX_SAMPLES = 64;
const samplesByStrategy = new Map<string, number[]>();

const keyOf = (tag: string, strategy: string): string => `${tag}:${strategy}`;

const percentileOf = (
	samples: readonly number[],
	percentile: number,
): number => {
	if (samples.length === 0) return 0;
	const sorted = [...samples].sort((left, right) => left - right);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(percentile * sorted.length) - 1),
	);
	return sorted[index] ?? 0;
};

export const adaptiveDelay = (
	strategy: string,
	options: Partial<Omit<AdaptiveDelay, "kind" | "strategy">> = {},
): AdaptiveDelay => {
	const min = Math.max(0, options.min ?? 75);
	const max = Math.max(min, options.max ?? 1_000);
	return Object.freeze({
		kind: "adaptive",
		strategy,
		percentile: Math.min(1, Math.max(0, options.percentile ?? 0.75)),
		min,
		max,
		fallback: Math.min(max, Math.max(min, options.fallback ?? 250)),
	});
};

export const resolveStrategyDelay = (
	tag: string,
	delay: StrategyDelay,
): number => {
	if (typeof delay === "number") return Math.max(0, delay);
	const samples = samplesByStrategy.get(keyOf(tag, delay.strategy));
	const observed = samples?.length
		? percentileOf(samples, delay.percentile)
		: delay.fallback;
	return Math.min(delay.max, Math.max(delay.min, observed));
};

export const recordStrategyLatency = (
	tag: string,
	strategy: string,
	durationMs: number,
): void => {
	const key = keyOf(tag, strategy);
	const samples = samplesByStrategy.get(key) ?? [];
	samples.push(durationMs);
	if (samples.length > MAX_SAMPLES) samples.shift();
	samplesByStrategy.set(key, samples);
};

export const clearStrategyLatencies = (): void => samplesByStrategy.clear();
