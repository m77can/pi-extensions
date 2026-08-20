/**
 * Config schema, normalization, and file persistence for pi-token-speed.
 *
 * The config file lives at ~/.pi/agent/pi-token-speed.json:
 *
 * {
 *   "version": 1,
 *   "config": { ...Config }
 * }
 *
 * Every update() call persists immediately, so settings survive /reload.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type FooterPosition = "right" | "line" | "off";

export type Config = {
	enabled: boolean;
	footer: boolean;
	working: boolean;
	/** "right" = right-aligned on the stats line, "line" = own line at the bottom, "off" = restore pi's built-in footer. */
	footerPosition: FooterPosition;
	label: string;
	workingPrefix: string;
	/** Interval at which the working indicator refreshes while streaming (ms). */
	renderIntervalMs: number;
	/** Sliding-window length for live tok/s (ms). */
	slidingWindowMs: number;
	/** Minimum message duration before a speed reading is considered reliable (ms). */
	minReliableDurationMs: number;
	/** Speeds above this tok/s are treated as invalid. */
	maxDisplayTokS: number;
	/** Prefer the provider's usage.output deltas over text estimation. */
	useProviderTokens: boolean;
	/** Text delta counting: "estimate" splits on word/punctuation runs, "direct" counts each delta as 1 token. */
	countStrategy: "estimate" | "direct";
};

export const DEFAULT_CONFIG: Config = {
	enabled: true,
	footer: true,
	working: true,
	footerPosition: "right",
	label: "tok/s",
	workingPrefix: "Working...",
	renderIntervalMs: 250,
	slidingWindowMs: 1000,
	minReliableDurationMs: 1000,
	maxDisplayTokS: 500,
	useProviderTokens: true,
	countStrategy: "estimate",
};

export type ConfigFile = {
	version: 1;
	config: Config;
};

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function normalize(raw: unknown): Config {
	const input = asRecord(raw);
	const config = asRecord(input.config);
	return {
		enabled: typeof config.enabled === "boolean" ? config.enabled : DEFAULT_CONFIG.enabled,
		footer: typeof config.footer === "boolean" ? config.footer : DEFAULT_CONFIG.footer,
		working: typeof config.working === "boolean" ? config.working : DEFAULT_CONFIG.working,
		footerPosition: isFooterPosition(config.footerPosition)
			? config.footerPosition
			: DEFAULT_CONFIG.footerPosition,
		label: typeof config.label === "string" && config.label ? config.label : DEFAULT_CONFIG.label,
		workingPrefix:
			typeof config.workingPrefix === "string" && config.workingPrefix
				? config.workingPrefix
				: DEFAULT_CONFIG.workingPrefix,
		renderIntervalMs: numberOr(config.renderIntervalMs, DEFAULT_CONFIG.renderIntervalMs),
		slidingWindowMs: numberOr(config.slidingWindowMs, DEFAULT_CONFIG.slidingWindowMs),
		minReliableDurationMs: numberOr(
			config.minReliableDurationMs,
			DEFAULT_CONFIG.minReliableDurationMs,
		),
		maxDisplayTokS: numberOr(config.maxDisplayTokS, DEFAULT_CONFIG.maxDisplayTokS),
		useProviderTokens:
			typeof config.useProviderTokens === "boolean"
				? config.useProviderTokens
				: DEFAULT_CONFIG.useProviderTokens,
		countStrategy:
			config.countStrategy === "estimate" || config.countStrategy === "direct"
				? config.countStrategy
				: DEFAULT_CONFIG.countStrategy,
	};
}

function isFooterPosition(value: unknown): value is FooterPosition {
	return value === "right" || value === "line" || value === "off";
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export class ConfigStore {
	private config = { ...DEFAULT_CONFIG };

	constructor(private jsonPath: string) {}

	load(): Config {
		this.config = normalize(readJson(this.jsonPath));
		return { ...this.config };
	}

	get current(): Config {
		return this.config;
	}

	/** Persist the config to disk immediately, so changes survive /reload. */
	update(next: Config): void {
		this.config = normalize(next);
		const file: ConfigFile = { version: 1, config: this.config };
		try {
			mkdirSync(dirname(this.jsonPath), { recursive: true });
			writeFileSync(this.jsonPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
		} catch {
			// Disk persistence is best-effort; in-memory config still applies.
		}
	}
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}