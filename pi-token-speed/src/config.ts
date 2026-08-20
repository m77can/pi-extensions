export type Config = {
	enabled: boolean;
	footer: boolean;
	working: boolean;
	label: string;
	footerPrefix: string;
	workingPrefix: string;
	/** Interval at which the footer status is refreshed while streaming (ms). */
	renderIntervalMs: number;
	/** Sliding-window length for live tok/s (ms). */
	slidingWindowMs: number;
	/** Minimum message duration before a speed reading is considered reliable (ms). */
	minReliableDurationMs: number;
	/** Speeds above this (tok/s) are treated as invalid. */
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
	label: "tok/s",
	footerPrefix: "session avg",
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
		label: typeof config.label === "string" && config.label ? config.label : DEFAULT_CONFIG.label,
		footerPrefix:
			typeof config.footerPrefix === "string" && config.footerPrefix
				? config.footerPrefix
				: DEFAULT_CONFIG.footerPrefix,
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

	update(next: Config): void {
		this.config = normalize(next);
	}

	enabled(): boolean {
		return this.config.enabled;
	}

	engineOptions() {
		return { ...this.config };
	}
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(require("node:fs").readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}