/**
 * Speed sampling from pi's assistantMessageEvent stream deltas.
 *
 * Kept dependency-free and framework-free so it stays testable outside pi.
 */

export type CountStrategy = "estimate" | "direct" | "chars";

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

	/** Sliding-window tok/s; suppresses unreliable burst-only readings. */
	get tokS(): number {
		const candidate = this.rawTokS;
		const stable = this.sanitizeTokS(candidate);
		if (stable !== null) this._lastStableTokS = stable;
		return this._lastStableTokS;
	}

	get rawTokS(): number {
		const now = this.now();
		if (this.elapsedMs < this.options.slidingWindowMs) return this.avgTokS;
		if (!this._isStreaming) return this.avgTokS;

		const windowStart = now - this.options.slidingWindowMs;
		while (
			this._windowStartIndex < this._events.length &&
			this._events[this._windowStartIndex].time < windowStart
		) {
			this._windowStartIndex++;
		}
		if (this._windowStartIndex >= this._events.length) return this.avgTokS;

		let windowTokenCount = 0;
		for (let i = this._windowStartIndex; i < this._events.length; i++) {
			windowTokenCount += this._events[i].tokens;
		}
		if (windowTokenCount === 0) return this.avgTokS;

		const windowDuration =
			(now - this._events[this._windowStartIndex].time) / 1000;
		return windowDuration > 0 ? windowTokenCount / windowDuration : 0;
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
			this.recordTokens(usageOutput - this._countedUsageOutput);
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
		const speed = this.engine.tokS;
		return speed > 0 ? speed : this.lastStableTokS;
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
		return { outputTokens: tokens, durationMs, tokS };
	}
}
