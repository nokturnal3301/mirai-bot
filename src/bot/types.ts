import type { BotLike, ContextType } from "gramio";
import type { Extractor, Media } from "extractors/types";

export type MessageContext = ContextType<BotLike, "message">;

export type Ctx<T = object> = { ctx: MessageContext } & T;
export type WithUrl = Ctx<{ url: string }>;
export type WithExtractor = WithUrl & { extractor: Extractor };
export type WithMedia = Ctx<{ url: string; media: Media }>;
