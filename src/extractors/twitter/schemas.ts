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

// Text fields shared by a tweet and the tweet it quotes.
const TweetTextShape = {
	text: z.string().optional(),
	display_text_range: z.array(z.number()).optional(),
	entities: z
		.looseObject({
			urls: z
				.array(
					z.looseObject({
						url: z.string(),
						expanded_url: z.string().optional(),
					}),
				)
				.optional(),
		})
		.optional(),
	user: z
		.looseObject({
			screen_name: z.string().optional(),
			name: z.string().optional(),
			verified: z.boolean().optional(),
			is_blue_verified: z.boolean().optional(),
		})
		.optional(),
} as const;

export const SyndicationResponseSchema = z.looseObject({
	...TweetTextShape,
	id_str: z.string().optional(),
	created_at: z.string().optional(),
	favorite_count: z.number().optional(),
	conversation_count: z.number().optional(),
	possibly_sensitive: z.boolean().optional(),
	in_reply_to_screen_name: z.string().optional(),
	note_tweet: z.unknown().optional(),
	quoted_tweet: z.looseObject(TweetTextShape).optional(),
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
export type SyndicationTweet = z.infer<typeof SyndicationResponseSchema>;
