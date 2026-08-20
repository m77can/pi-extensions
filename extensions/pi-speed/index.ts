import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getConfig, subscribeConfig } from "../../shared/pi-tui-store.js";
import { SpeedTracker } from "../../shared/speed-tracker.js";

/**
 * pi-speed — live output token speed (tok/s) in the streaming working indicator.
 *
 * Sole owner of `ctx.ui.setWorkingMessage()`; never touches the footer. The
 * session-average speed is rendered by the pi-footer module instead.
 *
 * Live speed uses the sliding-window SpeedTracker shared engine with the same
 * guardrails (min reliable duration, max plausible speed) as the former
 * pi-token-speed package.
 */

// Own SpeedTracker instance; live speed belongs only to this module.
const tracker = new SpeedTracker({ ...getConfig().speed });

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (mode === undefined || mode === "tui");
	} catch {
		return false;
	}
}

function formatSpeed(label: string, speed: number | null): string {
	if (speed === null) return "--";
	return `${speed.toFixed(1)} ${label}`;
}

export default function piSpeed(pi: ExtensionAPI): void {
	let workTimer: ReturnType<typeof setInterval> | undefined;

	function stopWorkTimer() {
		if (workTimer) clearInterval(workTimer);
		workTimer = undefined;
	}

	function renderWorking(ctx: ExtensionContext, speed: number | null) {
		if (!isTuiContext(ctx)) return;
		const config = getConfig();
		if (
			!config.enabled ||
			!config.modules.speed ||
			!config.speed.enabled ||
			!config.speed.working
		) {
			ctx.ui.setWorkingMessage();
			return;
		}
		const workingPrefix = config.speed.workingPrefix.trim();
		const text = formatSpeed(config.speed.label, speed);
		ctx.ui.setWorkingMessage(workingPrefix ? `${workingPrefix} ${text}` : text);
	}

	function startWorkTimer(ctx: ExtensionContext) {
		if (workTimer || !isTuiContext(ctx)) return;
		const config = getConfig();
		workTimer = setInterval(() => {
			const current = getConfig();
			if (
				!current.enabled ||
				!current.modules.speed ||
				!current.speed.enabled ||
				!current.speed.working ||
				!tracker.isStreaming
			) {
				stopWorkTimer();
				if (!current.speed.working) ctx.ui.setWorkingMessage();
				return;
			}
			renderWorking(ctx, tracker.liveTokS());
		}, config.speed.renderIntervalMs);
	}

	// ---- events ----
	pi.on("session_start", async () => {
		tracker.resetSession();
	});

	pi.on("message_start", (event, ctx) => {
		const config = getConfig();
		if (!config.enabled || !config.modules.speed || !config.speed.enabled) return;
		if (event.message?.role !== "assistant") return;
		tracker.startMessage();
		renderWorking(ctx, tracker.lastTokS ?? tracker.liveTokS());
		startWorkTimer(ctx);
	});

	pi.on("message_update", (event, ctx) => {
		const config = getConfig();
		if (!config.enabled || !config.modules.speed || !config.speed.enabled) return;
		if (event.message?.role !== "assistant") return;
		if (!tracker.isStreaming) return;
		const ev = event.assistantMessageEvent as
			| {
					type?: string;
					delta?: string;
					partial?: { usage?: { output?: number } };
			  }
			| undefined;
		if (!ev) return;
		if (ev.type === "text_delta" || ev.type === "thinking_delta") {
			tracker.recordDelta(ev.delta ?? "", ev.partial?.usage?.output);
		}
		renderWorking(ctx, tracker.liveTokS());
	});

	pi.on("message_end", (event, ctx) => {
		const config = getConfig();
		if (!config.enabled || !config.modules.speed || !config.speed.enabled) return;
		if (event.message?.role !== "assistant") return;
		const usageOutput =
			typeof event.message.usage === "object" && event.message.usage !== null
				? ((event.message.usage as { output?: number }).output ?? 0)
				: 0;
		const stopReason = (event.message as { stopReason?: string }).stopReason;
		tracker.finishMessage(usageOutput, stopReason);
		stopWorkTimer();
		renderWorking(ctx, tracker.lastTokS);
	});

	pi.on("turn_end", () => {
		tracker.stopMessage();
		stopWorkTimer();
	});

	pi.on("agent_end", (_event, ctx) => {
		tracker.stopMessage();
		stopWorkTimer();
		if (isTuiContext(ctx)) {
			ctx.ui.setWorkingMessage();
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopWorkTimer();
		if (isTuiContext(ctx)) {
			ctx.ui.setWorkingMessage();
		}
	});

	// Re-read live config after any change; existing timers keep running with the
	// previously captured interval but each tick already re-reads getConfig().
	subscribeConfig(() => {
		// no-op: config is read on demand inside every tick/handler
	});
}
