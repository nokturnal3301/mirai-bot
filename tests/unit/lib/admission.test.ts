import { describe, expect, test } from "bun:test";
import { withCpuAdmission } from "lib/admission";

describe("CPU admission", () => {
	test("serializes CPU-bound work without limiting unrelated strategies", async () => {
		let active = 0;
		let peak = 0;

		await Promise.all(
			[1, 2, 3].map(() =>
				withCpuAdmission(async () => {
					active++;
					peak = Math.max(peak, active);
					await Bun.sleep(5);
					active--;
				}),
			),
		);

		expect(peak).toBe(1);
	});
});
