import { z } from "zod";

const RenditionSchema = z.looseObject({
	url: z.string(),
	width: z.number().optional(),
	height: z.number().optional(),
});

type InstagramUser = {
	username?: string;
	full_name?: string | null;
	is_verified?: boolean | null;
};

type MusicAsset = {
	title?: string | null;
	display_artist?: string | null;
	progressive_download_url?: string | null;
	duration_in_ms?: number | null;
};

type OriginalSound = {
	original_audio_title?: string | null;
	ig_artist?: { username?: string | null } | null;
};

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
	has_audio?: boolean | null;
	clips_metadata?: {
		music_info?: {
			music_asset_info?: MusicAsset | null;
			music_consumption_info?: {
				should_mute_audio?: boolean | null;
				should_mute_audio_reason?: string | null;
			} | null;
		} | null;
		original_sound_info?: OriginalSound | null;
	} | null;
	music_metadata?: {
		music_info?: { music_asset_info?: MusicAsset | null } | null;
		original_sound_info?: OriginalSound | null;
	} | null;
	carousel_media?: InstagramMedia[];
	user?: InstagramUser;
	owner?: InstagramUser;
	caption?: { text?: string } | null;
	taken_at?: number | null;
	like_count?: number | null;
	comment_count?: number | null;
	view_count?: number | null;
	play_count?: number | null;
	ig_play_count?: number | null;
	like_and_view_counts_disabled?: boolean | null;
};

const UserSchema = z.looseObject({
	username: z.string().optional(),
	full_name: z.string().nullish(),
	is_verified: z.boolean().nullish(),
});

const MusicAssetSchema = z.looseObject({
	title: z.string().nullish(),
	display_artist: z.string().nullish(),
	progressive_download_url: z.string().nullish(),
	duration_in_ms: z.number().nullish(),
});

const OriginalSoundSchema = z.looseObject({
	original_audio_title: z.string().nullish(),
	ig_artist: z.looseObject({ username: z.string().nullish() }).nullish(),
});

const CountSchema = z.looseObject({ count: z.number().nullish() }).nullish();

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
		has_audio: z.boolean().nullish(),
		clips_metadata: z
			.looseObject({
				music_info: z
					.looseObject({
						music_asset_info: MusicAssetSchema.nullish(),
						music_consumption_info: z
							.looseObject({
								should_mute_audio: z.boolean().nullish(),
								should_mute_audio_reason: z.string().nullish(),
							})
							.nullish(),
					})
					.nullish(),
				original_sound_info: OriginalSoundSchema.nullish(),
			})
			.nullish(),
		music_metadata: z
			.looseObject({
				music_info: z
					.looseObject({ music_asset_info: MusicAssetSchema.nullish() })
					.nullish(),
				original_sound_info: OriginalSoundSchema.nullish(),
			})
			.nullish(),
		carousel_media: z.array(InstagramMediaSchema).optional(),
		user: UserSchema.optional(),
		owner: UserSchema.optional(),
		caption: z
			.looseObject({ text: z.string().optional() })
			.nullable()
			.optional(),
		taken_at: z.number().nullish(),
		like_count: z.number().nullish(),
		comment_count: z.number().nullish(),
		view_count: z.number().nullish(),
		play_count: z.number().nullish(),
		ig_play_count: z.number().nullish(),
		like_and_view_counts_disabled: z.boolean().nullish(),
	}),
);

export type InstagramGraphMedia = {
	shortcode?: string;
	is_video?: boolean;
	video_url?: string;
	display_url?: string;
	dimensions?: { width?: number; height?: number };
	video_duration?: number;
	owner?: InstagramUser;
	edge_media_to_caption?: {
		edges?: Array<{ node?: { text?: string } }>;
	};
	edge_sidecar_to_children?: {
		edges?: Array<{ node?: InstagramGraphMedia }>;
	};
	edge_liked_by?: { count?: number | null } | null;
	edge_media_preview_like?: { count?: number | null } | null;
	edge_media_to_comment?: { count?: number | null } | null;
	edge_media_to_parent_comment?: { count?: number | null } | null;
	video_view_count?: number | null;
	taken_at_timestamp?: number | null;
	like_and_view_counts_disabled?: boolean | null;
	clips_music_attribution_info?: {
		artist_name?: string | null;
		song_name?: string | null;
		uses_original_audio?: boolean | null;
	} | null;
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
			owner: UserSchema.optional(),
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
			edge_liked_by: CountSchema,
			edge_media_preview_like: CountSchema,
			edge_media_to_comment: CountSchema,
			edge_media_to_parent_comment: CountSchema,
			video_view_count: z.number().nullish(),
			taken_at_timestamp: z.number().nullish(),
			like_and_view_counts_disabled: z.boolean().nullish(),
			clips_music_attribution_info: z
				.looseObject({
					artist_name: z.string().nullish(),
					song_name: z.string().nullish(),
					uses_original_audio: z.boolean().nullish(),
				})
				.nullish(),
		}),
);

export const InstagramMediaInfoSchema = z.looseObject({
	items: z.array(InstagramMediaSchema).optional(),
});

export const InstagramGraphqlResponseSchema = z.looseObject({
	data: z
		.looseObject({
			xig_polaris_media: z
				.looseObject({
					gating_ruling: z
						.looseObject({ gating_type: z.number().optional() })
						.nullable()
						.optional(),
				})
				.nullable()
				.optional(),
		})
		.optional(),
});
