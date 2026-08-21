import test from "node:test";
import assert from "node:assert/strict";
import {
	estimateTokensFromDelta,
	SpeedTracker,
	type EngineOptions,
} from "../shared/speed-tracker.ts";

const base: EngineOptions = {
	slidingWindowMs: 1000,
	minReliableDurationMs: 100,
	maxDisplayTokS: 10000,
	useProviderTokens: false,
	countStrategy: "estimate",
};

test("estimateTokensFromDelta: estimate splits word-runs and punctuation", () => {
	assert.equal(estimateTokensFromDelta("", "estimate"), 0);
	assert.equal(estimateTokensFromDelta("hello world", "estimate"), 2);
	assert.equal(estimateTokensFromDelta("a, b!", "estimate"), 4);
	assert.equal(estimateTokensFromDelta("direct", "direct"), 1);
});

test("SpeedTracker: no speed under min duration", () => {
	const tracker = new SpeedTracker({ ...base, minReliableDurationMs: 1000 });
	tracker.startMessage();
	const r = tracker.finishMessage(100, undefined);
	assert.ok(r);
	assert.equal(r.tokS, null);
});

test("SpeedTracker: computes speed after reliable duration", () => {
	let now = 1000;
	const tracker = new SpeedTracker({
		...base,
		now: () => now,
		minReliableDurationMs: 100,
	});
	tracker.startMessage();
	now = 1500;
	tracker.recordDelta("one two three four five");
	const r = tracker.finishMessage(5, undefined);
	assert.ok(r);
	assert.ok(r.tokS !== null);
	assert.ok(r.tokS > 0);
});

test("SpeedTracker: session average accumulates successful messages", () => {
	let now = 1000;
	const tracker = new SpeedTracker({
		...base,
		now: () => now,
		minReliableDurationMs: 0,
	});
	tracker.resetSession();
	tracker.startMessage();
	now = 2000;
	tracker.finishMessage(100, undefined);
	assert.ok(tracker.sessionAvgTokS() !== null);
});

test("SpeedTracker: provider stream-end usage jump is not fed to live window", () => {
	let now = 1000;
	const tracker = new SpeedTracker({
		...base,
		useProviderTokens: true,
		now: () => now,
		minReliableDurationMs: 0,
	});
	tracker.startMessage();
	// Normal character deltas arrive over time.
	now += 200;
	tracker.recordDelta("hello world");
	const liveBefore = tracker.liveTokS();
	now += 100;
	// Provider final chunk reports the whole message usage (500 tokens).
	tracker.recordDelta("", 500);
	const liveAfter = tracker.liveTokS();
	assert.ok(
		liveBefore !== null && liveAfter !== null,
		"live speed should be non-null",
	);
	// Burst guard: the 500-token jump must not inflate live speed.
	// (2 tokens over 0.3s ≈ 6.7 tok/s; without the guard it would be ~1667.)
	assert.ok(
		liveAfter !== null && liveAfter < 100,
		`live speed should stay sane (got ${liveAfter})`,
	);
	// ...but finishMessage still reconciles to the authoritative total.
	const r = tracker.finishMessage(500, undefined);
	assert.ok(r);
	assert.equal(r.outputTokens, 500);
});
