export const config = {
	telegram: {
		maxFileSize: 50 * 1024 * 1024, // 50 MB (cloud bot API upload limit)
		maxMediaCaption: 1024, // chars in caption attached to a media message
		maxMessageText: 4096, // chars in a plain text message
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
