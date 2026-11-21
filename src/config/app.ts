export const config = {
	telegram: {
		maxFileSize: 50 * 1024 * 1024, // 50 MB (cloud bot API upload limit)
		maxCarouselItems: 20,
		maxCarouselBytes: 50 * 1024 * 1024,
		requestTimeout: 120_000, // per Bot API call, so uploads can't hang
	},
	youtube: {
		maxQuality: 1080,
	},
	instagram: {
		maxQuality: 720,
	},
	tiktok: {
		maxQuality: 720,
		targetFileSize: 16 * 1024 * 1024,
	},
	http: {
		// Media transfers can be large, so they get long deadlines.
		timeout: 30_000,
		attempts: 3,
		// Pages and API answers are small: a stalled one is better retried soon.
		pageTimeout: 10_000,
		pageAttempts: 2,
		maxDocumentSize: 5 * 1024 * 1024,
	},
	downloads: {
		// Requests downloading fresh media at once; the rest wait their turn.
		// Each can hold a 50 MB file in memory until Telegram has it.
		maxConcurrent: 4,
	},
	ffmpeg: {
		timeout: 120_000,
	},
	shutdown: {
		drainTimeout: 125_000,
	},
	rateLimit: {
		windowMs: 60_000,
		maxPerWindow: 5,
	},
} as const;
