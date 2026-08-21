/**
 * Cross-module runtime config store.
 *
 * Pi loads each extension factory with a fresh module registry (jiti
 * moduleCache:false), so `import` cannot share mutable singletons between the
 * pi-* modules. This store lives on globalThis (process-wide) so every module
 * reads/writes the same config object and receives change notifications.
 */
import {
	ensureConfigExists,
	loadConfig,
	saveConfig,
	type PiTuiConfig,
} from "./config.js";
import { SpeedTracker } from "./speed-tracker.js";
import {
	emptySessionMetrics,
	type SessionMetrics,
} from "./metrics.js";

const STORE_KEY = Symbol.for("pi-tui.store");

interface PiTuiStore {
	config: PiTuiConfig;
	/** Single shared speed engine. pi-speed feeds it (data owner); pi-footer only reads sessionAvgTokS(). */
	speedTracker: SpeedTracker;
	/** Whole-session harness metrics, owned by pi-metrics. */
	sessionMetrics: SessionMetrics;
	subscribers: Set<() => void>;
	requestFooterRender: (() => void) | undefined;
	editorControls:
		| {
				setCursorStyle: (style: PiTuiConfig["cursorStyle"]) => void;
				setWheelScrollLines: (lines: number) => void;
		  }
		| undefined;
}

type GlobalWithStore = typeof globalThis & { [STORE_KEY]?: PiTuiStore };

function initStore(): PiTuiStore {
	const g = globalThis as GlobalWithStore;
	const existing = g[STORE_KEY];
	if (existing) {
		// /reload keeps the process alive, so globalThis persists. A store
		// created by an older version of this file may be missing newer fields
		// (e.g. `speedTracker`, `sessionMetrics`). Backfill them instead of
		// returning a store that short-circuits the getters to undefined.
		if (!existing.speedTracker) {
			existing.speedTracker = new SpeedTracker(existing.config.speed);
		}
		if (!existing.sessionMetrics) {
			existing.sessionMetrics = emptySessionMetrics();
		}
		if (!existing.subscribers) existing.subscribers = new Set();
		return existing;
	}
	ensureConfigExists();
	const config = loadConfig();
	const store: PiTuiStore = {
		config,
		speedTracker: new SpeedTracker(config.speed),
		sessionMetrics: emptySessionMetrics(),
		subscribers: new Set(),
		requestFooterRender: undefined,
		editorControls: undefined,
	};
	g[STORE_KEY] = store;
	return store;
}

export function getConfig(): PiTuiConfig {
	return initStore().config;
}

export function getSpeedTracker(): SpeedTracker {
	return initStore().speedTracker;
}

export function getSessionMetrics(): SessionMetrics {
	return initStore().sessionMetrics;
}

export function subscribeConfig(fn: () => void): () => void {
	const store = initStore();
	store.subscribers.add(fn);
	return () => {
		store.subscribers.delete(fn);
	};
}

export function updateConfig(next: PiTuiConfig): void {
	const store = initStore();
	store.config = next;
	saveConfig(next);
	for (const sub of store.subscribers) {
		try {
			sub();
		} catch {
			// best-effort
		}
	}
}

export function setRequestFooterRender(fn: (() => void) | undefined): void {
	initStore().requestFooterRender = fn;
}

export function requestFooterRender(): void {
	initStore().requestFooterRender?.();
}

export function setEditorControls(
	controls: PiTuiStore["editorControls"],
): void {
	initStore().editorControls = controls;
}

export function getEditorControls(): PiTuiStore["editorControls"] {
	return initStore().editorControls;
}
