import assert from "node:assert/strict";
import { TokenSpeedEngine, SpeedTracker, estimateTokensFromDelta } from "../src/speed-tracker.ts";

function makeOpts(overrides = {}) {
	let now = 1000;
	return {
		opts: {
			slidingWindowMs: 1000,
			minReliableDurationMs: 1000,
			maxDisplayTokS: 500,
			useProviderTokens: false,
			countStrategy: "estimate",
			now: () => now,
			...overrides,
		},
		/** Advance the fake clock and return the new time. */
		advance(ms) {
			now += ms;
			return now;
		},
	};
}

// 1. text delta token estimation
assert.equal(estimateTokensFromDelta("hello, world!", "estimate"), 4);
assert.equal(estimateTokensFromDelta("hello, world!", "direct"), 1);
assert.equal(estimateTokensFromDelta("", "estimate"), 0);

// 2. short messages yield no speed (below minReliableDurationMs)
{
	const { opts, advance } = makeOpts();
	const eng = new TokenSpeedEngine(opts);
	eng.start();
	advance(200);
	eng.recordDelta("hello");
	eng.stop();
	assert.equal(eng.sanitizeTokS(eng.avgTokS, eng.elapsedMs), null);
}

// 3. whole-message average
{
	const { opts, advance } = makeOpts();
	const eng = new TokenSpeedEngine(opts);
	eng.start();
	advance(200);
	eng.recordDelta("hello world foo");
	eng.recordDelta("bar");
	advance(800);
	assert.ok(Math.abs(eng.avgTokS - 4) < 0.01, `avg must be 4, got ${eng.avgTokS}`);
	eng.stop();
}

// 4. speeds above maxDisplayTokS are sanitized away
{
	const { opts } = makeOpts();
	const eng = new TokenSpeedEngine(opts);
	assert.equal(eng.sanitizeTokS(9999, 5000), null);
}

// 5. sliding window: after 4s of streaming, speed reflects only the last ~1s
{
	const { opts, advance } = makeOpts();
	const eng = new TokenSpeedEngine(opts);
	eng.start();
	for (let i = 0; i < 40; i++) {
		eng.recordDelta("t");
		advance(100);
	}
	assert.ok(
		Math.abs(eng.rawTokS - 10) < 0.6,
		`sliding window tok/s must be ~10, got ${eng.rawTokS}`,
	);
	eng.stop();
}

// 6. tracker: successful messages feed the session average
{
	const { opts, advance } = makeOpts();
	const tr = new SpeedTracker(opts);
	tr.startMessage();
	advance(500);
	tr.recordDelta("a b c d e");
	advance(1500);
	const completed = tr.finishMessage(5, "stop");
	assert.ok(completed, "finishMessage should return a result while streaming");
	assert.equal(completed.outputTokens, 5);
	assert.ok(completed.tokS !== null && completed.tokS > 0);
	assert.ok(tr.sessionAvgTokS() !== null, "session average must exist after a successful message");
}

// 7. tracker: error/aborted messages are excluded from the session average
{
	const { opts, advance } = makeOpts();
	const tr = new SpeedTracker(opts);
	tr.startMessage();
	advance(2000);
	tr.recordDelta("ignored");
	tr.finishMessage(10, "error");
	assert.equal(tr.sessionAvgTokS(), null);
}

console.log("engine tests passed");