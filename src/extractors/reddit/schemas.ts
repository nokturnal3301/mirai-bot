import { z } from "zod";

const MediaSourceSchema = z.looseObject({
	u: z.string().optional(),
	url: z.string().optional(),
	width: z.number().optional(),
	height: z.number().optional(),
	x: z.number().optional(),
	y: z.number().optional(),
});

const MediaMetadataItemSchema = z.looseObject({
	status: z.string().optional(),
	e: z.string().optional(),
	m: z.string().optional(),
	s: MediaSourceSchema.optional(),
	p: z.array(MediaSourceSchema).optional(),
});

export const RedditPostSchema = z.looseObject({
	id: z.string().optional(),
	title: z.string().optional(),
	author: z.string().optional(),
	subreddit: z.string().optional(),
	selftext: z.string().optional(),
	is_gallery: z.boolean().optional(),
	is_video: z.boolean().optional(),
	is_self: z.boolean().optional(),
	url: z.string().optional(),
	url_overridden_by_dest: z.string().optional(),
	post_hint: z.string().optional(),
	domain: z.string().optional(),
	media: z
		.looseObject({
			reddit_video: z
				.looseObject({
					fallback_url: z.string().optional(),
					dash_url: z.string().optional(),
					hls_url: z.string().optional(),
					width: z.number().optional(),
					height: z.number().optional(),
					duration: z.number().optional(),
					is_gif: z.boolean().optional(),
				})
				.optional(),
		})
		.nullable()
		.optional(),
	preview: z
		.looseObject({
			images: z
				.array(
					z.looseObject({
						source: MediaSourceSchema.optional(),
					}),
				)
				.optional(),
		})
		.optional(),
	gallery_data: z
		.looseObject({
			items: z
				.array(
					z.looseObject({
						media_id: z.string(),
						id: z.number().optional(),
					}),
				)
				.optional(),
		})
		.optional(),
	media_metadata: z.record(z.string(), MediaMetadataItemSchema).optional(),
});

export const RedditListingSchema = z.array(
	z.looseObject({
		data: z
			.looseObject({
				children: z
					.array(
						z.looseObject({
							data: RedditPostSchema.optional(),
						}),
					)
					.optional(),
			})
			.optional(),
	}),
);
