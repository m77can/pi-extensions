/**
 * Calibration between character-estimated tokens (live speed) and the
 * provider's authoritative usage.output (turn-end TPS).
 *
 * Live speed estimates tokens from stream deltas; the provider announces the
 * truth only at message_end. This module keeps a running EWMA of the ratio
 *   scale = usage.output / estimatedTokens
 * for every assistant message, so the live display can be rescaled toward the
 * authoritative tokenizer count. A scale > 1 means estimates under-count
 * (typical for CJK/reasoning content); < 1 means over-count.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CalibrationSample {
	timestamp: number;
	estimatedTokens: number;
	usageOutput: number;
	scale: number;
}

export interface CalibrationState {
	/** EWMA of the scale ratios. 1 = no observed bias. */
	scale: number;
	samples: number;
	/** Most recent samples for ui.notify display. */
	recent: CalibrationSample[];
}

const FILE = join(
	process.env.HOME ?? "",
	".pi",
	"agent",
	"pi-metrics-calibration.json",
);

export function loadCalibration(): CalibrationState {
	try {
		const raw = JSON.parse(readFileSync(FILE, "utf8")) as Partial<CalibrationState>;
		return {
			scale: typeof raw.scale === "number" && raw.scale > 0 ? raw.scale : 1,
			samples: typeof raw.samples === "number" ? raw.samples : 0,
			recent: Array.isArray(raw.recent) ? raw.recent.slice(-20) : [],
		};
	} catch {
		return { scale: 1, samples: 0, recent: [] };
	}
}

function persist(state: CalibrationState): void {
	try {
		mkdirSync(dirname(FILE), { recursive: true });
		writeFileSync(FILE, JSON.stringify(state, null, 2), "utf8");
	} catch {
		// best-effort
	}
}

/**
 * Fold one finished message into the calibration, mutating `state` in place so
 * callers holding the reference see the updated scale immediately.
 * `estimatedTokens` is what the live estimator counted, `usageOutput` is the
 * provider's authoritative count.
 */
export function foldCalibration(
	state: CalibrationState,
	estimatedTokens: number,
	usageOutput: number,
): void {
	if (estimatedTokens <= 0 || usageOutput <= 0) return;
	const scale = usageOutput / estimatedTokens;
	// EWMA: recent samples weigh more, but a single sample never dominates.
	const alpha = 0.2;
	state.scale =
		state.scale === 1 && state.samples === 0
			? scale
			: state.scale * (1 - alpha) + scale * alpha;
	state.samples += 1;
	state.recent = [
		...state.recent,
		{ timestamp: Date.now(), estimatedTokens, usageOutput, scale },
	].slice(-20);
	persist(state);
}

/** Rescale an estimated tok/s toward the authoritative tokenizer count. */
export function calibrateTokS(estimated: number | null, state: CalibrationState): number | null {
	if (estimated === null || !Number.isFinite(estimated)) return null;
	if (!Number.isFinite(state.scale) || state.scale <= 0) return estimated;
	return estimated * state.scale;
}

export function calibrationExists(): boolean {
	return existsSync(FILE);
}