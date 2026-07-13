import { z } from "zod";

const RenditionSchema = z.looseObject({
	url: z.string(),
	width: z.number().optional(),
	height: z.number().optional(),
});

export type InstagramMedia = {
	code?: string;
	video_versions?: Array<{
		url: string;
		width?: number;
		height?: number;
	}>;
	image_versions2?: {
		candidates?: Array<{
			url: string;
			width?: number;
			height?: number;
		}>;
	};
	video_dash_manifest?: string | null;
	video_duration?: number;
	original_width?: number;
	original_height?: number;
	media_type?: number;
	carousel_media?: InstagramMedia[];
	user?: { username?: string };
	owner?: { username?: string };
	caption?: { text?: string } | null;
};

export const InstagramMediaSchema: z.ZodType<InstagramMedia> = z.lazy(() =>
	z.looseObject({
		code: z.string().optional(),
		video_versions: z.array(RenditionSchema).optional(),
		image_versions2: z
			.looseObject({ candidates: z.array(RenditionSchema).optional() })
			.optional(),
		video_dash_manifest: z.string().nullable().optional(),
		video_duration: z.number().optional(),
		original_width: z.number().optional(),
		original_height: z.number().optional(),
		media_type: z.number().optional(),
		carousel_media: z.array(InstagramMediaSchema).optional(),
		user: z.looseObject({ username: z.string().optional() }).optional(),
		owner: z.looseObject({ username: z.string().optional() }).optional(),
		caption: z
			.looseObject({ text: z.string().optional() })
			.nullable()
			.optional(),
	}),
);

export type InstagramGraphMedia = {
	shortcode?: string;
	is_video?: boolean;
	video_url?: string;
	display_url?: string;
	dimensions?: { width?: number; height?: number };
	video_duration?: number;
	owner?: { username?: string };
	edge_media_to_caption?: {
		edges?: Array<{ node?: { text?: string } }>;
	};
	edge_sidecar_to_children?: {
		edges?: Array<{ node?: InstagramGraphMedia }>;
	};
};

export const InstagramGraphMediaSchema: z.ZodType<InstagramGraphMedia> = z.lazy(
	() =>
		z.looseObject({
			shortcode: z.string().optional(),
			is_video: z.boolean().optional(),
			video_url: z.string().optional(),
			display_url: z.string().optional(),
			dimensions: z
				.looseObject({
					width: z.number().optional(),
					height: z.number().optional(),
				})
				.optional(),
			video_duration: z.number().optional(),
			owner: z.looseObject({ username: z.string().optional() }).optional(),
			edge_media_to_caption: z
				.looseObject({
					edges: z
						.array(
							z.looseObject({
								node: z.looseObject({ text: z.string().optional() }).optional(),
							}),
						)
						.optional(),
				})
				.optional(),
			edge_sidecar_to_children: z
				.looseObject({
					edges: z
						.array(
							z.looseObject({ node: InstagramGraphMediaSchema.optional() }),
						)
						.optional(),
				})
				.optional(),
		}),
);

export const InstagramMediaInfoSchema = z.looseObject({
	items: z.array(InstagramMediaSchema).optional(),
});
