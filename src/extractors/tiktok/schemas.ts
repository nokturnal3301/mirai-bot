import { z } from "zod";

const nonNegativeNumber = z.preprocess(
	(value) =>
		typeof value === "string" && value.trim() !== "" ? Number(value) : value,
	z.number().finite().nonnegative(),
);

// Engagement metadata never blocks extraction, so malformed values drop out.
const StatsSchema = z
	.looseObject({
		playCount: nonNegativeNumber.optional(),
		diggCount: nonNegativeNumber.optional(),
		commentCount: nonNegativeNumber.optional(),
	})
	.optional()
	.catch(undefined);

export const SSRItemSchema = z.looseObject({
	desc: z.string().optional(),
	isContentClassified: z.boolean().optional(),
	createTime: nonNegativeNumber.optional().catch(undefined),
	author: z
		.looseObject({
			uniqueId: z.string().optional(),
			nickname: z.string().optional(),
			verified: z.boolean().optional().catch(undefined),
		})
		.optional(),
	stats: StatsSchema,
	statsV2: StatsSchema,
	video: z
		.looseObject({
			bitrateInfo: z
				.array(
					z.looseObject({
						Bitrate: nonNegativeNumber.optional(),
						CodecType: z.string().optional(),
						PlayAddr: z
							.looseObject({
								UrlList: z.array(z.string()).max(8).optional(),
								DataSize: nonNegativeNumber.optional(),
								Width: nonNegativeNumber.optional(),
								Height: nonNegativeNumber.optional(),
							})
							.optional(),
					}),
				)
				.max(32)
				.optional(),
			playAddr: z.string().optional(),
			width: nonNegativeNumber.optional(),
			height: nonNegativeNumber.optional(),
			duration: nonNegativeNumber.optional(),
		})
		.optional(),
	imagePost: z
		.looseObject({
			images: z
				.array(
					z.looseObject({
						imageURL: z
							.looseObject({
								urlList: z.array(z.string()).max(8).optional(),
							})
							.optional(),
					}),
				)
				.max(20)
				.optional(),
		})
		.optional(),
	music: z
		.looseObject({
			playUrl: z.string().optional(),
			duration: nonNegativeNumber.optional(),
			title: z.string().optional(),
			authorName: z.string().optional(),
		})
		.optional(),
});

export type SSRItem = z.infer<typeof SSRItemSchema>;

export const SSRDataSchema = z.looseObject({
	__DEFAULT_SCOPE__: z
		.looseObject({
			"webapp.video-detail": z
				.looseObject({
					statusCode: nonNegativeNumber.optional(),
					statusMsg: z.string().optional(),
					itemInfo: z
						.looseObject({
							itemStruct: SSRItemSchema.optional(),
						})
						.optional(),
				})
				.optional(),
		})
		.optional(),
});
