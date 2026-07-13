import type { ExtractionError, ExtractionErrorCode } from "./errors";
import type { Flow } from "./flow";

const DEFAULT_FAILURE_CODES: readonly ExtractionErrorCode[] = [
	"UPSTREAM_REJECTED",
	"SCHEMA_MISMATCH",
	"DOWNLOAD_FAILED",
];

export type CircuitBreakerPolicy = Readonly<{
	failures: number;
	resetAfter: number;
	failureCodes?: readonly ExtractionErrorCode[];
}>;

type CircuitState =
	| { phase: "closed"; failures: number }
	| { phase: "open"; retryAt: number }
	| { phase: "half-open" };

export type CircuitPermit = Readonly<{
	key: string;
	mode: "closed" | "probe";
	policy: CircuitBreakerPolicy;
}>;

export type CircuitTransition = "opened" | "closed" | undefined;

const states = new Map<string, CircuitState>();

const keyOf = (tag: string, strategy: string): string => `${tag}:${strategy}`;

export const acquireCircuitPermit = (
	tag: string,
	strategy: string,
	policy: CircuitBreakerPolicy,
): CircuitPermit | null => {
	const key = keyOf(tag, strategy);
	const state = states.get(key);
	if (!state || state.phase === "closed") {
		return { key, mode: "closed", policy };
	}
	if (state.phase === "half-open" || state.retryAt > Date.now()) return null;

	states.set(key, { phase: "half-open" });
	return { key, mode: "probe", policy };
};

const opensCircuit = (permit: CircuitPermit): CircuitTransition => {
	states.set(permit.key, {
		phase: "open",
		retryAt: Date.now() + Math.max(1, permit.policy.resetAfter),
	});
	return "opened";
};

export const completeCircuitPermit = <T>(
	permit: CircuitPermit,
	result: Flow<T, ExtractionError>,
): CircuitTransition => {
	if (result._tag !== "Fail") {
		const transitioned = states.has(permit.key);
		states.delete(permit.key);
		return transitioned ? "closed" : undefined;
	}

	if (result.error.code === "ABORTED") {
		if (permit.mode === "probe") return opensCircuit(permit);
		return undefined;
	}

	const failureCodes = permit.policy.failureCodes ?? DEFAULT_FAILURE_CODES;
	if (!failureCodes.includes(result.error.code)) {
		const transitioned = states.has(permit.key);
		states.delete(permit.key);
		return transitioned ? "closed" : undefined;
	}

	if (permit.mode === "probe") return opensCircuit(permit);
	const state = states.get(permit.key);
	if (state?.phase === "open") return undefined;
	const failures = (state?.phase === "closed" ? state.failures : 0) + 1;
	if (failures >= Math.max(1, permit.policy.failures)) {
		return opensCircuit(permit);
	}
	states.set(permit.key, { phase: "closed", failures });
	return undefined;
};

export const clearCircuitBreakers = (): void => states.clear();
