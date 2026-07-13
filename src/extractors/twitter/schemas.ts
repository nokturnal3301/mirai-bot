import { z } from "zod";

const VideoVariantSchema = z.looseObject({
	bitrate: z.number().optional(),
	content_type: z.string(),
	url: z.string(),
});

export const MediaDetailSchema = z.looseObject({
	type: z.enum(["photo", "video", "animated_gif"]),
	media_url_https: z.string().optional(),
	original_info: z
		.looseObject({
			width: z.number().optional(),
			height: z.number().optional(),
		})
		.optional(),
	video_info: z
		.looseObject({
			duration_millis: z.number().optional(),
			variants: z.array(VideoVariantSchema).optional(),
		})
		.optional(),
});

export const SyndicationResponseSchema = z.looseObject({
	id_str: z.string().optional(),
	text: z.string().optional(),
	user: z
		.looseObject({
			screen_name: z.string().optional(),
		})
		.optional(),
	mediaDetails: z.array(MediaDetailSchema).optional(),
	photos: z
		.array(
			z.looseObject({
				url: z.string(),
				width: z.number().optional(),
				height: z.number().optional(),
			}),
		)
		.optional(),
});

export type MediaDetail = z.infer<typeof MediaDetailSchema>;
