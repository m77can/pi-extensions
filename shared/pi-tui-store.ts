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

const STORE_KEY = Symbol.for("pi-tui.store");

interface PiTuiStore {
	config: PiTuiConfig;
	/** Single shared speed engine. pi-speed feeds it (data owner); pi-footer only reads sessionAvgTokS(). */
	speedTracker: SpeedTracker;
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
	if (g[STORE_KEY]) return g[STORE_KEY];
	ensureConfigExists();
	const config = loadConfig();
	const store: PiTuiStore = {
		config,
		speedTracker: new SpeedTracker(config.speed),
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
