import { describe, test, expect } from "bun:test";
import { F, chain } from "lib/flow";
import type { Flow } from "lib/flow";

describe("Flow", () => {
	describe("constructors", () => {
		test("of creates Continue flow", () => {
			const flow = F.of(42);

			expect(flow._tag).toBe("Continue");
			expect(flow._tag === "Continue" && flow.value).toBe(42);
		});

		test("stop creates Stop flow", () => {
			const flow = F.stop();

			expect(flow._tag).toBe("Stop");
		});

		test("fail creates Fail flow with error", () => {
			const flow = F.fail("something went wrong");

			expect(flow._tag).toBe("Fail");
			if (flow._tag === "Fail") {
				expect(flow.error).toBe("something went wrong");
			}
		});
	});

	describe("fromNullable", () => {
		test("returns Continue for a value", () => {
			const flow = F.fromNullable(42);

			expect(flow._tag).toBe("Continue");
			expect(flow._tag === "Continue" && flow.value).toBe(42);
		});

		test("returns Continue for zero", () => {
			const flow = F.fromNullable(0);

			expect(flow._tag).toBe("Continue");
			expect(flow._tag === "Continue" && flow.value).toBe(0);
		});

		test("returns Continue for empty string", () => {
			const flow = F.fromNullable("");

			expect(flow._tag).toBe("Continue");
		});

		test("returns Stop for null", () => {
			expect(F.fromNullable(null)._tag).toBe("Stop");
		});

		test("returns Stop for undefined", () => {
			expect(F.fromNullable(undefined)._tag).toBe("Stop");
		});
	});

	describe("failIfNull", () => {
		test("returns Continue for a value", () => {
			const flow = F.failIfNull("missing", 42);
			expect(flow._tag).toBe("Continue");
		});

		test("returns Fail with error for null", () => {
			const flow = F.failIfNull("missing", null);
			expect(flow._tag).toBe("Fail");
			if (flow._tag === "Fail") expect(flow.error).toBe("missing");
		});
	});

	describe("type guards", () => {
		test("isContinue returns true for Continue", () => {
			const flow = F.of(42);
			expect(F.isContinue(flow)).toBe(true);
			expect(F.isStop(flow)).toBe(false);
			expect(F.isFail(flow)).toBe(false);
		});

		test("isStop returns true for Stop", () => {
			const flow = F.stop();
			expect(F.isContinue(flow)).toBe(false);
			expect(F.isStop(flow)).toBe(true);
			expect(F.isFail(flow)).toBe(false);
		});

		test("isFail returns true for Fail", () => {
			const flow = F.fail("error");
			expect(F.isContinue(flow)).toBe(false);
			expect(F.isStop(flow)).toBe(false);
			expect(F.isFail(flow)).toBe(true);
		});
	});

	describe("map", () => {
		test("transforms Continue value", () => {
			const flow = F.of(5);
			const result = F.map(flow, (x) => x * 2);

			expect(result._tag).toBe("Continue");
			expect(result._tag === "Continue" && result.value).toBe(10);
		});

		test("passes through Stop", () => {
			const flow = F.stop();
			const result = F.map(flow, (x: number) => x * 2);

			expect(result._tag).toBe("Stop");
		});

		test("passes through Fail", () => {
			const flow = F.fail("error");
			const result = F.map(flow, (x: number) => x * 2);

			expect(result._tag).toBe("Fail");
			if (result._tag === "Fail") expect(result.error).toBe("error");
		});
	});

	describe("flatMap", () => {
		test("chains Continue flows", () => {
			const flow = F.of(5);
			const result = F.flatMap(flow, (x) => F.of(x * 2));

			expect(result._tag).toBe("Continue");
			expect(result._tag === "Continue" && result.value).toBe(10);
		});

		test("allows switching to Stop", () => {
			const flow = F.of(5);
			const result = F.flatMap(flow, () => F.stop());

			expect(result._tag).toBe("Stop");
		});

		test("allows switching to Fail", () => {
			const flow = F.of(5);
			const result = F.flatMap(flow, () => F.fail("oops"));

			expect(result._tag).toBe("Fail");
		});

		test("passes through Stop", () => {
			const flow: Flow<number> = F.stop();
			const result = F.flatMap(flow, (x) => F.of(x * 2));

			expect(result._tag).toBe("Stop");
		});
	});
});

describe("chain", () => {
	test("chains sync transformations", async () => {
		const result = await chain(F.of(5))
			.pipe((x) => F.of(x * 2))
			.pipe((x) => F.of(x + 1))
			.run();

		expect(result._tag).toBe("Continue");
		expect(result._tag === "Continue" && result.value).toBe(11);
	});

	test("chains async transformations", async () => {
		const result = await chain(F.of(5))
			.pipe(async (x) => F.of(x * 2))
			.pipe(async (x) => F.of(x + 1))
			.run();

		expect(result._tag).toBe("Continue");
		expect(result._tag === "Continue" && result.value).toBe(11);
	});

	test("stops chain on Stop", async () => {
		let reached = false;

		const result = await chain(F.of(5))
			.pipe((x) => F.of(x * 2))
			.pipe(() => F.stop())
			.pipe((x) => {
				reached = true;
				return F.of(x + 1);
			})
			.run();

		expect(result._tag).toBe("Stop");
		expect(reached).toBe(false);
	});

	test("stops chain on Fail", async () => {
		let reached = false;

		const result = await chain(F.of(5))
			.pipe((x) => F.of(x * 2))
			.pipe(() => F.fail("oops"))
			.pipe((x) => {
				reached = true;
				return F.of(x + 1);
			})
			.run();

		expect(result._tag).toBe("Fail");
		if (result._tag === "Fail") {
			expect(result.error).toBe("oops");
		}
		expect(reached).toBe(false);
	});

	test("preserves type through chain", async () => {
		const result = await chain(F.of({ name: "test" }))
			.pipe((obj) => F.of({ ...obj, count: 5 }))
			.pipe((obj) => F.of({ ...obj, active: true }))
			.run();

		expect(result._tag).toBe("Continue");
		if (result._tag === "Continue") {
			expect(result.value.name).toBe("test");
			expect(result.value.count).toBe(5);
			expect(result.value.active).toBe(true);
		}
	});

	test("handles mixed sync/async transformations", async () => {
		const result = await chain(F.of(1))
			.pipe((x) => F.of(x + 1))
			.pipe(async (x) => F.of(x * 2))
			.pipe((x) => F.of(x.toString()))
			.run();

		expect(result._tag).toBe("Continue");
		expect(result._tag === "Continue" && result.value).toBe("4");
	});
});

describe("recover", () => {
	test("recovers from Fail", async () => {
		const result = await chain(F.of(5))
			.pipe(() => F.fail("error"))
			.recover((error) => F.of(`recovered: ${error}`))
			.run();

		expect(result._tag).toBe("Continue");
		if (result._tag === "Continue") {
			expect(result.value).toBe("recovered: error");
		}
	});

	test("recover can return Stop", async () => {
		const result = await chain(F.of(5))
			.pipe(() => F.fail("error"))
			.recover(() => F.stop())
			.run();

		expect(result._tag).toBe("Stop");
	});

	test("recover is not called for Continue", async () => {
		let recoverCalled = false;

		const result = await chain(F.of(5))
			.pipe((x) => F.of(x * 2))
			.recover(() => {
				recoverCalled = true;
				return F.stop();
			})
			.run();

		expect(result._tag).toBe("Continue");
		expect(recoverCalled).toBe(false);
	});

	test("recover is not called for Stop", async () => {
		let recoverCalled = false;

		const result = await chain(F.of(5))
			.pipe(() => F.stop())
			.recover(() => {
				recoverCalled = true;
				return F.of(0);
			})
			.run();

		expect(result._tag).toBe("Stop");
		expect(recoverCalled).toBe(false);
	});

	test("async recover", async () => {
		const result = await chain(F.of(5))
			.pipe(() => F.fail("error"))
			.recover(async (error) => {
				await Promise.resolve();
				return F.of(`recovered: ${error}`);
			})
			.run();

		expect(result._tag).toBe("Continue");
		if (result._tag === "Continue") {
			expect(result.value).toBe("recovered: error");
		}
	});
});

describe("onStop", () => {
	test("replaces Stop with a Continue", async () => {
		const result = await chain(F.of(5))
			.pipe(() => F.stop())
			.onStop(() => F.of(42))
			.run();

		expect(result._tag).toBe("Continue");
		if (result._tag === "Continue") expect(result.value).toBe(42);
	});

	test("does not run for Continue", async () => {
		let called = false;
		const result = await chain(F.of(5))
			.onStop(() => {
				called = true;
				return F.of(0);
			})
			.run();

		expect(result._tag).toBe("Continue");
		expect(called).toBe(false);
	});

	test("does not run for Fail", async () => {
		let called = false;
		const result = await chain(F.of(5))
			.pipe(() => F.fail("nope"))
			.onStop(() => {
				called = true;
				return F.of(0);
			})
			.run();

		expect(result._tag).toBe("Fail");
		expect(called).toBe(false);
	});
});

describe("catch", () => {
	test("catches Fail", async () => {
		const result = await chain(F.of(5))
			.pipe(() => F.fail("oops"))
			.catch((reason) =>
				reason.tag === "Fail" ? F.of(`got ${reason.error}`) : F.of("stop"),
			)
			.run();

		expect(result._tag).toBe("Continue");
		if (result._tag === "Continue") expect(result.value).toBe("got oops");
	});

	test("catches Stop", async () => {
		const result = await chain(F.of(5))
			.pipe(() => F.stop())
			.catch((reason) =>
				reason.tag === "Stop" ? F.of("caught stop") : F.of("fail"),
			)
			.run();

		expect(result._tag).toBe("Continue");
		if (result._tag === "Continue") expect(result.value).toBe("caught stop");
	});
});

describe("result", () => {
	test("returns value for Continue", async () => {
		const result = await chain(F.of(5))
			.pipe((x) => F.of(x * 2))
			.result();

		expect(result).toBe(10);
	});

	test("returns null for Stop", async () => {
		const result = await chain(F.of(5))
			.pipe(() => F.stop())
			.result();

		expect(result).toBeNull();
	});

	test("returns null for Fail", async () => {
		const result = await chain(F.of(5))
			.pipe(() => F.fail("error"))
			.result();

		expect(result).toBeNull();
	});

	test("works with async transforms", async () => {
		const result = await chain(F.of("hello"))
			.pipe(async (s) => F.of(s.toUpperCase()))
			.result();

		expect(result).toBe("HELLO");
	});
});
