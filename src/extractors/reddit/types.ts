import type { z } from "zod";
import type { RedditPostSchema } from "extractors/reddit/schemas";

export type RedditPost = z.infer<typeof RedditPostSchema>;
