import test from "node:test";
import assert from "node:assert/strict";
import {
	TurnMetricsAccumulator,
	SessionMetricsAccumulator,
	cacheHitPercent,
	sessionTokensPerSecond,
} from "../shared/metrics.ts";

// ── TurnMetricsAccumulator ──────────────────────────────────────────────────

const assistantLike = {
	role: "assistant",
	usage: {
		input: 0,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};
const assistantLikeWithUsage = assistantLike;

test("TurnMetricsAccumulator: ttft + decode derive (now injected)", () => {
	let now = 0;
	const acc = new TurnMetricsAccumulator(() => now);

	now = 0;
	acc.startTurn();
	now = 100; // first token
	acc.onMessageUpdate(assistantLike, "hi");
	now = 200;
	acc.onMessageUpdate(assistantLike, "there");
	now = 300;
	acc.onMessageUpdate(assistantLike, "more");
	now = 500; // message end
	acc.onMessageEnd(assistantLikeWithUsage);

	const t = acc.resolve();
	assert.ok(t);
	assert.equal(t.ttftMs, 100);
	assert.equal(t.decodeMs, 400); // 500 - 100
	assert.equal(t.outputTokens, 10);
});

// ── SessionMetricsAccumulator ──────────────────────────────────────────────

test("SessionMetricsAccumulator: steps/turns/llmMs/decode/cache fold", () => {
	const acc = new SessionMetricsAccumulator();
	acc.stepStart(0);
	acc.firstToken(0);
	// decode: messageEnd uses real performance.now(); just assert increments are sane
	acc.messageEnd(0, {
		input: 1000,
		output: 200,
		cacheRead: 800,
		cacheWrite: 50,
		totalTokens: 1200,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	acc.stepEnd(0);

	const m = acc.metrics;
	assert.equal(m.turns, 1);
	assert.equal(m.steps, 1);
	assert.equal(m.decodeTokens, 200);
	assert.equal(m.cacheRead, 800);
	assert.equal(m.cacheWrite, 50);
	assert.equal(m.uncachedInput, 150); // 1000 - 800 - 50
	assert.equal(m.llmMs >= 0, true);
});

test("SessionMetricsAccumulator: tool wall time pairs call/result", () => {
	const acc = new SessionMetricsAccumulator();
	acc.toolCall("c1");
	acc.toolResult("c1");
	assert.ok(acc.metrics.toolMs >= 0);
	// unmatched result must not corrupt
	acc.toolResult("nonexistent");
	assert.ok(Number.isFinite(acc.metrics.toolMs));
});

// ── cacheHitPercent / sessionTokensPerSecond ───────────────────────────────

test("cacheHitPercent: harness formula", () => {
	const m = {
		turns: 0,
		steps: 0,
		llmMs: 0,
		toolMs: 0,
		ttftMs: 0,
		ttftSteps: 0,
		decodeMs: 0,
		decodeTokens: 0,
		cacheRead: 800,
		cacheWrite: 50,
		uncachedInput: 150,
	};
	// 800 / (150+800+50) = 800/1000 = 80%
	assert.equal(cacheHitPercent(m), 80);
});

test("sessionTokensPerSecond: harness cumulative decode throughput", () => {
	const m = {
		turns: 0,
		steps: 0,
		llmMs: 0,
		toolMs: 0,
		ttftMs: 0,
		ttftSteps: 0,
		decodeMs: 2000,
		decodeTokens: 120,
		cacheRead: 0,
		cacheWrite: 0,
		uncachedInput: 0,
	};
	// 120 / 2s = 60 tok/s
	assert.equal(sessionTokensPerSecond(m), 60);
});

// ── estimateTokensFromDelta chars strategy (regression) ────────────────────

test("estimateTokensFromDelta: chars strategy ~ len/4", async () => {
	const { estimateTokensFromDelta } = await import("../shared/speed-tracker.ts");
	assert.equal(estimateTokensFromDelta("", "chars"), 0);
	assert.equal(estimateTokensFromDelta("abcdefgh", "chars"), 2); // 8/4
	assert.equal(estimateTokensFromDelta("hello world", "chars"), 3); // 11/4 = 2.75 → 3
});
