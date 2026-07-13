import type { Extractor } from "extractors/types";
import { instagram } from "extractors/instagram/extractor";
import { youtube } from "extractors/youtube/extractor";
import { tiktok } from "extractors/tiktok/extractor";
import { threads } from "extractors/threads/extractor";
import { twitter } from "extractors/twitter/extractor";
import { reddit } from "extractors/reddit/extractor";

const extractors: Extractor[] = [
	instagram,
	youtube,
	tiktok,
	threads,
	twitter,
	reddit,
];

export const findExtractor = (url: string): Extractor | undefined =>
	extractors.find((extractor) => extractor.match(url));
