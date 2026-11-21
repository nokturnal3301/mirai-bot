import type { BotLike, ContextType } from "gramio";
import type { Extractor, Media } from "extractors/types";

export type MessageContext = ContextType<BotLike, "message">;

export type Ctx<T = object> = { ctx: MessageContext } & T;
export type WithLinks = Ctx<{ links: string[] }>;
export type WithExtractor = Ctx<{ url: string; extractor: Extractor }>;
export type WithMedia = Ctx<{ url: string; media: Media }>;
