import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Metrics accumulation aligned to the deepseek-harness `session-stats`
 * projection semantics (see docs/metrics-design.md):
 *
 *   TTFT     = firstTokenTime − stepStartTime
 *   decodeMs = messageCompleteTime − firstTokenTime   (excludes TTFT)
 *   tok/s    = outputTokens / (decodeMs / 1000)
 *
 * The denominator semantics follow harness exactly. Because this extension runs
 * INSIDE the streaming process (unlike harness, which folds a settled log), we
 * additionally layer pi-tps' anti-buffer-flush gates so dispatch bursts don't
 * report fake 5000+ tok/s readings.
 */

/** Gap between consecutive token updates above which we count a stall. */
export const STALL_THRESHOLD_MS = 500;
/** Maximum plausible inference speed; beyond this the reading is a measurement artifact. */
export const MAX_PLAUSIBLE_TPS = 10_000;

/** Per-turn accumulated facts, mirroring harness `StepReading` + pi-tps timing. */
export interface TurnTiming {
	turnStartMs: number;
	/** Time of the first content-bearing update (effective first token). */
	firstTokenMs: number | null;
	/** Start of the inter-update streaming window (the update AFTER the first token). */
	firstStreamUpdateMs: number | null;
	/** Time of the most recent streaming update. */
	lastStreamUpdateMs: number;
	/** Number of streaming updates after the first token (pi-tps `updateCount`). */
	updateCount: number;
	/** Time of the last update, for stall detection. */
	lastUpdateMs: number;
	/** Message completion time (message_end). */
	messageEndMs: number | null;
	/** Wall-clock message_start → message_end for each assistant message. */
	generationMs: number;
	/** Accumulated stall time. */
	stallMs: number;
	/** Number of discrete stall events. */
	stallCount: number;
	/** Whether a tool executed during this turn. */
	isToolCall: boolean;
	/** Assistant messages ended in this turn (carry authoritative usage). */
	messages: AssistantMessage[];
	inStall: boolean;
	messageStartMs: number | null;
}

export interface TurnTelemetry {
	tps: number | null;
	tpsPrimary: boolean;
	ttftMs: number | null;
	totalMs: number;
	generationMs: number;
	decodeMs: number | null;
	streamMs: number | null;
	stallMs: number;
	stallCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
}

export interface SessionMetrics {
	turns: number;
	steps: number;
	llmMs: number;
	toolMs: number;
	ttftMs: number;
	ttftSteps: number;
	decodeMs: number;
	decodeTokens: number;
	cacheRead: number;
	cacheWrite: number;
	uncachedInput: number;
}

function round(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

/** Sum provider-reported usage across a turn's assistant messages. */
export function foldMessageUsage(messages: AssistantMessage[]): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
} {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalTokens = 0;
	for (const m of messages) {
		const u = m.usage;
		if (!u) continue;
		input += u.input ?? 0;
		output += u.output ?? 0;
		cacheRead += u.cacheRead ?? 0;
		cacheWrite += u.cacheWrite ?? 0;
		totalTokens += u.totalTokens ?? 0;
	}
	return { input, output, cacheRead, cacheWrite, totalTokens };
}

/** A message is assistant-role; usage may still be absent mid-stream. */
function isAssistantMessage(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const m = message as Record<string, unknown>;
	return m.role === "assistant";
}

/** Assistant message with a complete (or at least present) usage record. */
function isAssistantWithUsage(message: unknown): message is AssistantMessage {
	if (!isAssistantMessage(message)) return false;
	const m = message as Record<string, unknown>;
	return typeof m.usage === "object" && m.usage !== null;
}

/**
 * Per-turn accumulator. Lives inside one LLM turn; resolves to `TurnTelemetry`
 * at `turn_end`.
 */
export class TurnMetricsAccumulator {
	private readonly now: () => number;
	private timing: TurnTiming | null = null;

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	startTurn(): void {
		const now = this.now();
		this.timing = {
			turnStartMs: now,
			firstTokenMs: null,
			firstStreamUpdateMs: null,
			lastStreamUpdateMs: now,
			updateCount: 0,
			lastUpdateMs: now,
			messageEndMs: null,
			generationMs: 0,
			stallMs: 0,
			stallCount: 0,
			isToolCall: false,
			messages: [],
			inStall: false,
			messageStartMs: null,
		};
	}

	onMessageStart(message: unknown): void {
		if (!this.timing || !isAssistantMessage(message)) return;
		const now = this.now();
		this.timing.messageStartMs = now;
		this.timing.lastUpdateMs = now;
		this.timing.inStall = false;
	}

	/**
	 * Record a streaming update. The first content-bearing delta is the effective
	 * first token (TTFT endpoint). Subsequent updates drive the inter-update
	 * decode window and stall detection (pi-tps semantics).
	 */
	onMessageUpdate(message: unknown, delta: string): void {
		const timing = this.timing;
		if (!timing || !isAssistantMessage(message)) return;
		// Ignore empty deltas for timing purposes.
		if (!delta || delta.length === 0) return;

		const now = this.now();

		// First token: capture TTFT endpoint and seed stall clock. No stall
		// detection on this event (the gap before it is TTFT, not a stall).
		if (timing.firstTokenMs === null) {
			timing.firstTokenMs = now;
			timing.lastUpdateMs = now;
			return;
		}

		// Inter-update streaming window.
		timing.updateCount++;
		if (timing.firstStreamUpdateMs === null) {
			timing.firstStreamUpdateMs = now;
		}
		timing.lastStreamUpdateMs = now;

		const gap = now - timing.lastUpdateMs;
		if (gap >= STALL_THRESHOLD_MS) {
			if (!timing.inStall) timing.stallCount++;
			timing.inStall = true;
			timing.stallMs += gap;
		} else {
			timing.inStall = false;
		}
		timing.lastUpdateMs = now;
	}

	onMessageEnd(message: unknown): void {
		if (!this.timing || !isAssistantWithUsage(message)) return;
		const now = this.now();
		if (timingMessageStart(this.timing)) {
			this.timing.generationMs += now - this.timing.messageStartMs!;
			this.timing.messageStartMs = null;
		}
		this.timing.messageEndMs = now;
		this.timing.messages.push(message);
	}

	onToolExecutionStart(): void {
		if (this.timing) this.timing.isToolCall = true;
	}

	/** Resolve accumulated timing into telemetry; null when no meaningful output. */
	resolve(): TurnTelemetry | null {
		const timing = this.timing;
		this.timing = null;
		if (!timing) return null;
		if (timing.firstTokenMs === null || timing.messages.length === 0) return null;

		const usage = foldMessageUsage(timing.messages);
		if (usage.output <= 0) return null;

		const turnEndMs = this.now();
		const totalMs = turnEndMs - timing.turnStartMs;
		const ttftMs = timing.firstTokenMs - timing.turnStartMs;

		const decodeMs =
			timing.messageEndMs === null
				? null
				: Math.max(0, timing.messageEndMs - timing.firstTokenMs);

		const streamMs =
			timing.updateCount > 0 && timing.firstStreamUpdateMs !== null
				? timing.lastStreamUpdateMs - timing.firstStreamUpdateMs
				: null;

		const tps = computeTurnTps({
			outputTokens: usage.output,
			streamMs,
			updateCount: timing.updateCount,
			stallMs: timing.stallMs,
			generationMs: timing.generationMs,
		});

		return {
			tps: tps.value,
			tpsPrimary: tps.primary,
			ttftMs,
			totalMs,
			generationMs: timing.generationMs,
			decodeMs,
			streamMs,
			stallMs: timing.stallMs,
			stallCount: timing.stallCount,
			inputTokens: usage.input,
			outputTokens: usage.output,
			cacheReadTokens: usage.cacheRead,
			cacheWriteTokens: usage.cacheWrite,
			totalTokens: usage.totalTokens,
		};
	}
}

function timingMessageStart(t: TurnTiming): boolean {
	return t.messageStartMs !== null;
}

const MIN_STREAM_MS = 1;
const MIN_STREAM_UPDATES = 5;
const MIN_INTER_CHUNK_MS = 1;
const MIN_GENERATION_MS = 200;

/**
 * Compute per-turn TPS with harness decode-denominator semantics layered with
 * pi-tps anti-buffer-flush gates.
 *
 * Primary path: output / ((decodeMs − stallMs) / 1000), gated by
 *   - ≥ MIN_STREAM_UPDATES updates
 *   - avg inter-chunk gap ≥ MIN_INTER_CHUNK_MS
 *   - stall doesn't dominate the window
 *   - effective window ≥ MIN_GENERATION_MS
 * Fallback path: output / ((generationMs − stallMs) / 1000) — includes TTFT,
 *   intentionally lower.
 * Guard: tps > MAX_PLAUSIBLE_TPS → null.
 */
export function computeTurnTps(input: {
	outputTokens: number;
	streamMs: number | null;
	updateCount: number;
	stallMs: number;
	generationMs: number;
}): { value: number | null; primary: boolean } {
	const { outputTokens, streamMs, updateCount, stallMs, generationMs } = input;

	const avgInterChunkGap =
		streamMs !== null && updateCount > 1 ? streamMs / (updateCount - 1) : 0;

	let tps: number | null = null;
	let primary = false;

	if (
		streamMs !== null &&
		streamMs >= MIN_STREAM_MS &&
		updateCount >= MIN_STREAM_UPDATES &&
		avgInterChunkGap >= MIN_INTER_CHUNK_MS &&
		stallMs < streamMs &&
		streamMs - stallMs >= MIN_GENERATION_MS &&
		stallMs < streamMs - stallMs
	) {
		const effectiveStreamMs = streamMs - stallMs;
		tps = round(outputTokens / (effectiveStreamMs / 1000), 1);
		primary = true;
	} else if (updateCount >= 2 && generationMs >= MIN_GENERATION_MS) {
		const effectiveGenMs = Math.max(generationMs - stallMs, MIN_GENERATION_MS);
		tps = round(outputTokens / (effectiveGenMs / 1000), 1);
	}

	if (tps !== null && tps > MAX_PLAUSIBLE_TPS) {
		tps = null;
		primary = false;
	}

	return { value: tps, primary };
}

/**
 * Whole-session accumulator, mirroring harness `session-stats` totals:
 * turns/steps/llmMs/toolMs/ttftMs/ttftSteps/decodeMs/decodeTokens + cache buckets.
 */
export class SessionMetricsAccumulator {
	private state: SessionMetrics;
	private lastTurn: number | null = null;
	private openStep: {
		turn: number;
		startTime: number;
		firstTokenTime: number | null;
	} | null = null;
	private pendingCalls = new Map<string, number>();

	constructor() {
		this.state = emptySessionMetrics();
	}

	private get now(): number {
		return performance.now();
	}

	stepStart(turnIndex: number): void {
		this.openStep = {
			turn: turnIndex,
			startTime: this.now,
			firstTokenTime: null,
		};
	}

	firstToken(turnIndex: number): void {
		const open = this.openStep;
		if (!open || open.turn !== turnIndex) return;
		if (open.firstTokenTime !== null) return;
		this.openStep = { ...open, firstTokenTime: this.now };
	}

	messageEnd(turnIndex: number, usage: AssistantMessage["usage"]): void {
		const open = this.openStep;
		if (!open || open.turn !== turnIndex) return;

		this.state.llmMs += Math.max(0, this.now - open.startTime);
		this.openStep = null;

		if (open.firstTokenTime !== null) {
			this.state.ttftMs += Math.max(0, open.firstTokenTime - open.startTime);
			this.state.ttftSteps += 1;

			const outputTokens = usageOutputTokens(usage);
			if (outputTokens !== null) {
				this.state.decodeMs += Math.max(0, this.now - open.firstTokenTime);
				this.state.decodeTokens += outputTokens;
			}
		}

		// Cache buckets: uncachedInput = input − cacheRead − cacheWrite (Pi's Usage
		// has no explicit `uncachedInput`; harness bills the three disjoint buckets).
		if (usage) {
			this.state.cacheRead += usage.cacheRead ?? 0;
			this.state.cacheWrite += usage.cacheWrite ?? 0;
			const input = usage.input ?? 0;
			const uncached = Math.max(
				0,
				input - (usage.cacheRead ?? 0) - (usage.cacheWrite ?? 0),
			);
			this.state.uncachedInput += uncached;
		}
	}

	toolCall(callId: string): void {
		this.pendingCalls.set(callId, this.now);
	}

	toolResult(callId: string): void {
		const dispatched = this.pendingCalls.get(callId);
		if (dispatched === undefined) return;
		this.state.toolMs += Math.max(0, this.now - dispatched);
		this.pendingCalls.delete(callId);
	}

	stepEnd(turnIndex: number): void {
		this.state.steps += 1;
		if (this.lastTurn !== turnIndex) {
			this.state.turns += 1;
			this.lastTurn = turnIndex;
		}
		this.openStep = null;
	}

	reset(): void {
		this.state = emptySessionMetrics();
		this.lastTurn = null;
		this.openStep = null;
		this.pendingCalls.clear();
	}

	get metrics(): SessionMetrics {
		return this.state;
	}
}

export function emptySessionMetrics(): SessionMetrics {
	return {
		turns: 0,
		steps: 0,
		llmMs: 0,
		toolMs: 0,
		ttftMs: 0,
		ttftSteps: 0,
		decodeMs: 0,
		decodeTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
		uncachedInput: 0,
	};
}

function usageOutputTokens(usage: unknown): number | null {
	if (typeof usage !== "object" || usage === null) return null;
	const value = (usage as { output?: unknown }).output;
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

/** harness cache-hit share: cacheRead / (uncachedInput + cacheRead + cacheWrite). */
export function cacheHitPercent(m: SessionMetrics): number | null {
	const denominator = m.uncachedInput + m.cacheRead + m.cacheWrite;
	if (denominator === 0) return null;
	return Math.round((m.cacheRead / denominator) * 100);
}

/** harness cumulative decode throughput over the whole session. */
export function sessionTokensPerSecond(m: SessionMetrics): number | null {
	if (m.decodeMs <= 0 || m.decodeTokens <= 0) return null;
	return m.decodeTokens / (m.decodeMs / 1000);
}

/** harness format: ≥10 → integer, <10 → one decimal. */
export function formatTokensPerSecond(tps: number): string {
	const clamped = Math.max(0, tps);
	return clamped >= 10
		? String(Math.round(clamped))
		: String(Math.round(clamped * 10) / 10);
}
