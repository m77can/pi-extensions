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
