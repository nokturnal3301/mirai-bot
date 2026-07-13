import type { MediaPlan } from "extractors/media";
import { F, defineStrategy, extractionError } from "lib";
import { IMAGE_HEADERS } from "extractors/reddit/constants";
import { extractIReddId } from "extractors/reddit/utils";

export const image = defineStrategy("image", (url: string) => {
	if (!extractIReddId(url)) {
		return F.fail(extractionError("NOT_APPLICABLE", "not an i.redd.it image"));
	}

	return F.of<MediaPlan>({
		type: "photo",
		source: { kind: "download", url, headers: IMAGE_HEADERS },
	});
});
