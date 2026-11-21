import type { DashManifest } from "./types";

// Platforms bury the post somewhere inside a large JSON payload whose shape
// keeps changing, so it is found by what it looks like, not by a fixed path.
export const findDeep = <T>(
	value: unknown,
	pick: (node: object) => T | null,
): T | null => {
	if (value === null || typeof value !== "object") return null;

	const picked = pick(value);
	if (picked !== null) return picked;

	for (const child of Object.values(value)) {
		const found = findDeep(child, pick);
		if (found !== null) return found;
	}
	return null;
};

const REPRESENTATION_PATTERN =
	/<Representation\b([^>]*)>[\s\S]*?<BaseURL>([^<]+)<\/BaseURL>/g;

const adaptationSetOf = (
	manifest: string,
	type: "audio" | "video",
): string | undefined =>
	manifest.match(
		new RegExp(
			`<AdaptationSet[^>]*contentType="${type}"[\\s\\S]*?</AdaptationSet>`,
		),
	)?.[0];

const attributeOf = (tag: string, name: string): string | undefined =>
	tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

// A DASH manifest lists one audio track and the video in several qualities,
// each as a <Representation> with its own file URL. Picking a quality is left
// to the platform.
export const parseDash = (manifest: string): DashManifest => {
	const xml = manifest.replace(/&amp;/g, "&");
	const audioUrl = xml.match(
		/<AdaptationSet[^>]*contentType="audio"[\s\S]*?<BaseURL>([^<]+)<\/BaseURL>/,
	)?.[1];
	const videos = Array.from(
		(adaptationSetOf(xml, "video") ?? "").matchAll(REPRESENTATION_PATTERN),
		([, tag = "", url = ""]) => ({
			url,
			width: Number(attributeOf(tag, "width")),
			height: Number(attributeOf(tag, "height")),
			bandwidth: Number(attributeOf(tag, "bandwidth") ?? 0),
			codecs: attributeOf(tag, "codecs") ?? "",
		}),
	).filter(({ width, height }) => width > 0 && height > 0);

	return { audioUrl, videos };
};
