import { z } from "zod";

export const FormatSchema = z.looseObject({
	url: z.string().optional(),
	mimeType: z.string().optional(),
	bitrate: z.number().optional(),
	width: z.number().optional(),
	height: z.number().optional(),
	contentLength: z.string().optional(),
	approxDurationMs: z.string().optional(),
	audioTrack: z
		.looseObject({
			displayName: z.string().optional(),
			id: z.string().optional(),
			audioIsDefault: z.boolean().optional(),
			isAutoDubbed: z.boolean().optional(),
		})
		.optional(),
});

export const InnertubeResponseSchema = z.looseObject({
	playabilityStatus: z
		.looseObject({
			status: z.string().optional(),
			reason: z.string().optional(),
		})
		.optional(),
	streamingData: z
		.looseObject({
			formats: z.array(FormatSchema).optional(),
			adaptiveFormats: z.array(FormatSchema).optional(),
		})
		.optional(),
	videoDetails: z
		.looseObject({
			title: z.string().optional(),
			lengthSeconds: z.string().optional(),
			author: z.string().optional(),
			channelId: z.string().optional(),
		})
		.optional(),
});
