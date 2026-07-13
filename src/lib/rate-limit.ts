type Bucket = { count: number; resetAt: number };

export type RateLimiter = {
	check: (key: string | number) => boolean;
};

export const createRateLimiter = (options: {
	windowMs: number;
	maxPerWindow: number;
	maxKeys?: number;
}): RateLimiter => {
	const buckets = new Map<string | number, Bucket>();
	const maxKeys = Math.max(1, options.maxKeys ?? 10_000);
	let checks = 0;

	const prune = (now: number): void => {
		for (const [key, bucket] of buckets) {
			if (bucket.resetAt <= now) buckets.delete(key);
		}
		while (buckets.size >= maxKeys) {
			const oldest = buckets.keys().next().value;
			if (oldest === undefined) break;
			buckets.delete(oldest);
		}
	};

	return {
		check: (key) => {
			const now = Date.now();
			checks++;
			if (checks % 256 === 0 || buckets.size >= maxKeys) prune(now);
			const bucket = buckets.get(key);

			if (!bucket || bucket.resetAt <= now) {
				buckets.set(key, { count: 1, resetAt: now + options.windowMs });
				return true;
			}

			if (bucket.count >= options.maxPerWindow) return false;

			bucket.count += 1;
			buckets.delete(key);
			buckets.set(key, bucket);
			return true;
		},
	};
};
