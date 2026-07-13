import type { z } from "zod";
import type { ThreadsPostSchema } from "extractors/threads/schemas";

export type ThreadsPost = z.infer<typeof ThreadsPostSchema>;
