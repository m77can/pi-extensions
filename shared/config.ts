import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
	normalizeFullscreenWheelScrollLines,
} from "./fullscreen-scroll.js";
import type { IconMode } from "./icons.js";

export type SettingsLanguage = "en" | "zh";
export type CursorStyle = "block" | "bar" | "underline";
export type CountStrategy = "estimate" | "direct" | "chars";

export type { IconMode } from "./icons.js";

/** Which pi-* modules are loaded/enabled. The settings module owns the /pi-tui command itself. */
export interface ModulesConfig {
	header: boolean;
	editor: boolean;
	footer: boolean;
	metrics: boolean;
	settings: boolean;
}

export interface FooterSegments {
	cwd: boolean;
	sessionName: boolean;
	gitBranch: boolean;
	gitStatus: boolean;
	gitCommit: boolean;
	runtime: boolean;
	context: boolean;
	tokens: boolean;
	cost: boolean;
	extensionStatuses: boolean;
	/** Session-average decode throughput (harness tok/s) shown in the footer. */
	speed: boolean;
	/** DeepSeek cache-hit share (harness cacheRead / billed input). */
	cacheHit: boolean;
}

export interface TelemetryConfig {
	enabled: boolean;
	tps: boolean;
	ttft: boolean;
	duration: boolean;
	tokens: boolean;
	stalls: boolean;
	cost: boolean;
}

export interface SpeedConfig {
	enabled: boolean;
	/** Live tok/s in the streaming working indicator (pi-speed module). */
	working: boolean;
	label: string;
	workingPrefix: string;
	renderIntervalMs: number;
	slidingWindowMs: number;
	minReliableDurationMs: number;
	maxDisplayTokS: number;
	useProviderTokens: boolean;
	countStrategy: CountStrategy;
}

export interface FullscreenConfig {
	wheelScrollLines: number;
}

export interface PiTuiConfig {
	enabled: boolean;
	settingsLanguage: SettingsLanguage;
	cursorStyle: CursorStyle;
	fullscreen: FullscreenConfig;
	icons: { mode: IconMode };
	modules: ModulesConfig;
	footerSegments: FooterSegments;
	telemetry: TelemetryConfig;
	speed: SpeedConfig;
}

export const DEFAULT_CONFIG: PiTuiConfig = {
	enabled: true,
	settingsLanguage: "zh",
	cursorStyle: "block",
	fullscreen: { wheelScrollLines: DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES },
	icons: { mode: "auto" },
	modules: {
		header: true,
		editor: true,
		footer: true,
		metrics: true,
		settings: true,
	},
	footerSegments: {
		cwd: true,
		sessionName: false,
		gitBranch: true,
		gitStatus: true,
		gitCommit: false,
		runtime: true,
		context: true,
		tokens: true,
		cost: true,
		extensionStatuses: true,
		speed: true,
		cacheHit: true,
	},
	telemetry: {
		enabled: true,
		tps: true,
		ttft: true,
		duration: true,
		tokens: true,
		stalls: true,
		cost: true,
	},
	speed: {
		enabled: true,
		working: true,
		label: "tok/s",
		workingPrefix: "Working...",
		renderIntervalMs: 250,
		slidingWindowMs: 1000,
		minReliableDurationMs: 1000,
		maxDisplayTokS: 500,
		useProviderTokens: true,
		countStrategy: "estimate",
	},
};

export function getConfigPath(): string {
	return join(getAgentDir(), "pi-tui.json");
}

function deepMerge<T>(base: T, override: unknown): T {
	if (typeof base !== "object" || base === null || Array.isArray(base)) {
		return (override as T) ?? base;
	}
	if (
		typeof override !== "object" ||
		override === null ||
		Array.isArray(override)
	) {
		return base;
	}
	const result = { ...(base as Record<string, unknown>) };
	const overrideRec = override as Record<string, unknown>;
	for (const key of Object.keys(overrideRec)) {
		const baseVal = (base as Record<string, unknown>)[key];
		const overVal = overrideRec[key];
		if (
			typeof baseVal === "object" &&
			baseVal !== null &&
			!Array.isArray(baseVal) &&
			typeof overVal === "object" &&
			overVal !== null &&
			!Array.isArray(overVal)
		) {
			result[key] = deepMerge(baseVal, overVal);
		} else if (overVal !== undefined) {
			result[key] = overVal;
		}
	}
	return result as T;
}

function normalizeConfig(config: PiTuiConfig): PiTuiConfig {
	if (config.settingsLanguage !== "en" && config.settingsLanguage !== "zh") {
		config.settingsLanguage = DEFAULT_CONFIG.settingsLanguage;
	}
	if (
		config.cursorStyle !== "block" &&
		config.cursorStyle !== "bar" &&
		config.cursorStyle !== "underline"
	) {
		config.cursorStyle = DEFAULT_CONFIG.cursorStyle;
	}
	config.fullscreen.wheelScrollLines = normalizeFullscreenWheelScrollLines(
		config.fullscreen.wheelScrollLines,
		DEFAULT_CONFIG.fullscreen.wheelScrollLines,
	);
	if (
		config.speed.countStrategy !== "estimate" &&
		config.speed.countStrategy !== "direct" &&
		config.speed.countStrategy !== "chars"
	) {
		config.speed.countStrategy = DEFAULT_CONFIG.speed.countStrategy;
	}
	return config;
}

export function ensureConfigExists(): void {
	const path = getConfigPath();
	if (existsSync(path)) return;
	try {
		const agentDir = getAgentDir();
		if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
	} catch {
		// best-effort
	}
}

export function loadConfig(
	notify?: (msg: string, level: "warning" | "info") => void,
): PiTuiConfig {
	const path = getConfigPath();
	if (!existsSync(path)) {
		ensureConfigExists();
		return structuredClone(DEFAULT_CONFIG);
	}
	try {
		const raw = readFileSync(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		const merged = deepMerge(DEFAULT_CONFIG, parsed);
		return normalizeConfig(merged);
	} catch (err) {
		notify?.(
			`pi-tui config parse error: ${err instanceof Error ? err.message : String(err)}`,
			"warning",
		);
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function saveConfig(config: PiTuiConfig): void {
	const path = getConfigPath();
	try {
		const agentDir = getAgentDir();
		if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
	} catch {
		// best-effort
	}
}
