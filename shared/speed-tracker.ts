/**
 * Speed sampling from pi's assistantMessageEvent stream deltas.
 *
 * Kept dependency-free and framework-free so it stays testable outside pi.
 */

export type CountStrategy = "estimate" | "direct" | "chars";

/**
 * Single provider usage jump above this is the end-of-stream summary
 * (pi requests stream_options.include_usage) — it must not enter the live
 * sliding window, or one chunk inflates the speed to hundreds of tok/s.
 */
const MAX_USAGE_JUMP = 100;

export interface TokenEvent {
	time: number;
	tokens: number;
}

export interface EngineOptions {
	/** Sliding window length in ms. After streaming for this long, tok/s is
	 * computed over only the last window instead of the whole message. */
	slidingWindowMs: number;
	/** Messages shorter than this many ms yield no speed at all. */
	minReliableDurationMs: number;
	/** Speeds above this (tok/s) are treated as invalid. */
	maxDisplayTokS: number;
	/** Prefer the provider's usage.output deltas over text estimation. */
	useProviderTokens: boolean;
	countStrategy: CountStrategy;
	now?: () => number;
}

export interface CompletedMessageSpeed {
	outputTokens: number;
	durationMs: number;
	/** The estimator's count before authoritative reconcile; also in `tokenCount`. */
	estimatedTokens: number;
	/** Sanitized tokens-per-second for the completed assistant message, or null. */
	tokS: number | null;
}

function isSuccessfulStop(stopReason: string | undefined): boolean {
	return stopReason !== "error" && stopReason !== "aborted";
}

/** Rough token estimate from a stream delta: word-ish runs and single non-space/symbol chars. */
export function estimateTokensFromDelta(
	text: string,
	strategy: CountStrategy,
): number {
	if (!text) return 0;
	if (strategy === "direct") return 1;
	if (strategy === "chars") return Math.max(1, Math.round(text.length / 4));
	const matches = text.match(/\w+|[^\s\w]/g);
	return matches ? matches.length : 0;
}

export class TokenSpeedEngine {
	private _isStreaming = false;
	private _tokenCount = 0;
	private _startTime = 0;
	private _endTime = 0;
	private _events: TokenEvent[] = [];
	private _windowStartIndex = 0;
	private _countedUsageOutput = 0;
	private _lastStableTokS = 0;

	private options: EngineOptions;

	constructor(options: EngineOptions) {
		this.options = options;
	}

	get isStreaming(): boolean {
		return this._isStreaming;
	}

	get tokenCount(): number {
		return this._tokenCount;
	}

	get elapsedMs(): number {
		if (this._startTime === 0) return 0;
		if (this._isStreaming) return this.now() - this._startTime;
		return this._endTime - this._startTime;
	}

	get avgTokS(): number {
		const elapsedSec = this.elapsedMs / 1000;
		if (elapsedSec <= 0) return 0;
		return this._tokenCount / elapsedSec;
	}

	private now(): number {
		return this.options.now ? this.options.now() : Date.now();
	}

	sanitizeTokS(
		value: number | null,
		durationMs = this.elapsedMs,
	): number | null {
		if (value === null || !Number.isFinite(value) || value <= 0) return null;
		if (durationMs < this.options.minReliableDurationMs) return null;
		if (value > this.options.maxDisplayTokS) return null;
		return value;
	}

	/** Live tok/s — cumulative average (total tokens ÷ total elapsed), matching
	 * pi-web's streaming badge (tokens count includes thinking; elapsed starts
	 * at message_start, so thinking time is included in the denominator). */
	get tokS(): number {
		const candidate = this.rawTokS;
		const stable = this.sanitizeTokS(candidate);
		if (stable !== null) this._lastStableTokS = stable;
		return this._lastStableTokS;
	}

	get rawTokS(): number {
		return this.avgTokS;
	}

	start(): void {
		this._tokenCount = 0;
		this._isStreaming = true;
		this._startTime = this.now();
		this._endTime = this._startTime;
		this._events = [];
		this._windowStartIndex = 0;
		this._countedUsageOutput = 0;
		this._lastStableTokS = 0;
	}

	stop(): void {
		this._isStreaming = false;
		this._endTime = this.now();
		this._events = [];
		this._windowStartIndex = 0;
	}

	recordDelta(delta: string, usageOutput?: number): void {
		if (!this._isStreaming) return;
		if (
			this.options.useProviderTokens &&
			usageOutput !== undefined &&
			usageOutput > this._countedUsageOutput
		) {
			const jump = usageOutput - this._countedUsageOutput;
			// burst guard: pi requests stream_options.include_usage, so providers
			// (DeepSeek etc.) emit ONE final chunk with the whole message's usage.
			// A single jump of hundreds of tokens is that end-of-stream summary,
			// not live decode rate — record it for reconcile but never feed it
			// into the sliding window (that's the 300+ tok/s spike).
			if (jump > MAX_USAGE_JUMP) {
				this._countedUsageOutput = usageOutput;
				return;
			}
			this.recordTokens(jump);
			this._countedUsageOutput = usageOutput;
			return;
		}
		this.recordTokens(estimateTokensFromDelta(delta, this.options.countStrategy));
	}

	reconcileTotal(tokens: number): void {
		if (tokens > 0) this._tokenCount = tokens;
	}

	private recordTokens(tokens: number): void {
		if (!this._isStreaming || tokens <= 0) return;
		this._tokenCount += tokens;
		this._events.push({ time: this.now(), tokens });
		if (this._windowStartIndex >= 5000) this.compact();
	}

	private compact(): void {
		if (this._windowStartIndex === 0) return;
		this._events = this._events.slice(this._windowStartIndex);
		this._windowStartIndex = 0;
	}
}

export class SpeedTracker {
	private engine: TokenSpeedEngine;
	private lastStableTokS: number | null = null;
	private sessionOutputTokens = 0;
	private sessionDurationMs = 0;

	constructor(options: EngineOptions) {
		this.engine = new TokenSpeedEngine(options);
	}

	get isStreaming(): boolean {
		return this.engine.isStreaming;
	}

	get lastTokS(): number | null {
		return this.lastStableTokS;
	}

	/** Estimated tokens for the current message BEFORE reconcile — the number
	 * the live display was actually using. `finishMessage` replaces the
	 * usable count with the authoritative usage.output, so this cannot be
	 * read after finishMessage.
	 */
	get estimatedTokenCount(): number {
		return this.engine.tokenCount;
	}

	resetSession(): void {
		this.sessionOutputTokens = 0;
		this.sessionDurationMs = 0;
	}

	startMessage(): void {
		this.engine.start();
	}

	recordDelta(delta: string, usageOutput?: number): void {
		this.engine.recordDelta(delta, usageOutput);
	}

	stopMessage(): void {
		if (this.engine.isStreaming) this.engine.stop();
	}

	liveTokS(): number | null {
		const windowed = this.engine.tokS; // sanitized sliding window
		if (windowed > 0) return windowed;
		const raw = this.engine.rawTokS; // pre-sanitize live value
		if (raw > 0) return raw;
		return this.lastStableTokS;
	}

	sessionAvgTokS(): number | null {
		return this.sessionDurationMs > 0
			? this.sessionOutputTokens / (this.sessionDurationMs / 1000)
			: null;
	}

	finishMessage(
		outputTokens: number,
		stopReason: string | undefined,
	): CompletedMessageSpeed | null {
		if (!this.engine.isStreaming) return null;
		const estimated = this.engine.tokenCount;
		this.engine.reconcileTotal(outputTokens);
		const durationMs = this.engine.elapsedMs;
		const tokens = this.engine.tokenCount;
		const rawAvgTokS = durationMs > 0 ? tokens / (durationMs / 1000) : null;
		const tokS = this.engine.sanitizeTokS(rawAvgTokS, durationMs);
		this.lastStableTokS = tokS;
		this.engine.stop();

		if (tokS !== null && isSuccessfulStop(stopReason)) {
			this.sessionOutputTokens += tokens;
			this.sessionDurationMs += durationMs;
		}
		return { outputTokens: tokens, estimatedTokens: estimated, durationMs, tokS };
	}
}
