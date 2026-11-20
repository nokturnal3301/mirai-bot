import { z } from "zod";

const VideoVersionSchema = z.looseObject({
	url: z.string(),
	width: z.number().optional(),
	height: z.number().optional(),
});

const ImageCandidateSchema = z.looseObject({
	url: z.string(),
	width: z.number().optional(),
	height: z.number().optional(),
});

// Shared shape between a top-level post and a quoted/reposted attachment.
const PostMediaShape = {
	pk: z.string().nullish(),
	code: z.string().nullish(),
	media_type: z.number().nullish(),
	video_versions: z.array(VideoVersionSchema).nullish(),
	image_versions2: z
		.looseObject({
			candidates: z.array(ImageCandidateSchema).nullish(),
		})
		.nullish(),
	carousel_media: z
		.array(
			z.looseObject({
				media_type: z.number().nullish(),
				video_versions: z.array(VideoVersionSchema).nullish(),
				image_versions2: z
					.looseObject({
						candidates: z.array(ImageCandidateSchema).nullish(),
					})
					.nullish(),
				original_width: z.number().nullish(),
				original_height: z.number().nullish(),
			}),
		)
		.nullish(),
	original_width: z.number().nullish(),
	original_height: z.number().nullish(),
	video_duration: z.number().nullish(),
} as const;

const QuotedAttachmentSchema = z.looseObject(PostMediaShape);

export const ThreadsPostSchema = z.looseObject({
	...PostMediaShape,
	caption: z
		.looseObject({
			text: z.string().nullish(),
		})
		.nullish(),
	user: z
		.looseObject({
			username: z.string().nullish(),
			full_name: z.string().nullish(),
			is_verified: z.boolean().nullish(),
		})
		.nullish(),
	like_count: z.number().nullish(),
	like_and_view_counts_disabled: z.boolean().nullish(),
	taken_at: z.number().nullish(),
	text_post_app_info: z
		.looseObject({
			direct_reply_count: z.number().nullish(),
			is_spoiler_media: z.boolean().nullish(),
			linked_inline_media: QuotedAttachmentSchema.nullish(),
			share_info: z
				.looseObject({
					quoted_attachment_post: QuotedAttachmentSchema.nullish(),
					quoted_post: z
						.looseObject({
							caption: z.looseObject({ text: z.string().nullish() }).nullish(),
							user: z.looseObject({ username: z.string().nullish() }).nullish(),
						})
						.nullish(),
				})
				.nullish(),
		})
		.nullish(),
});

export type ThreadsPost = z.infer<typeof ThreadsPostSchema>;
