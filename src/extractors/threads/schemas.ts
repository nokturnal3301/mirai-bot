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
		})
		.nullish(),
	text_post_app_info: z
		.looseObject({
			share_info: z
				.looseObject({
					quoted_attachment_post: QuotedAttachmentSchema.nullish(),
				})
				.nullish(),
		})
		.nullish(),
});

export type ThreadsPost = z.infer<typeof ThreadsPostSchema>;
