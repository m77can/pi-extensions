import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { IconMode } from "../../shared/config.js";
import {
	getConfig,
	getSpeedTracker,
	getSessionMetrics,
} from "../../shared/pi-tui-store.js";
import {
	SessionMetricsAccumulator,
	TurnMetricsAccumulator,
	type TurnTelemetry,
} from "../../shared/metrics.js";
import {
	calibrateTokS,
	foldCalibration,
	loadCalibration,
} from "../../shared/calibration.js";
import { resolveGlyphs } from "../../shared/icons.js";
import { fmtTokens } from "../../shared/utils.js";

/**
 * pi-metrics — unified speed + telemetry module (replaces pi-speed + pi-telemetry).
 *
 * Sole owner of the speed/telemetry data:
 *   1. Live tok/s in the streaming working indicator (sliding window).
 *   2. Per-turn telemetry at turn_end (harness decode throughput + TTFT/stall).
 *   3. Whole-session harness metrics fed into the global store for pi-footer.
 *
 * Data layer gating: feeding is gated by `enabled` only (never by display
 * switches), so hiding the working indicator doesn't starve the footer.
 */

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

/** harness format: ≥10 → integer, <10 → one decimal. */
function formatTokensPerSecond(tps: number): string {
	const clamped = Math.max(0, tps);
	return clamped >= 10
		? String(Math.round(clamped))
		: String(Math.round(clamped * 10) / 10);
}

function formatTurnDuration(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const whole = Math.round(ms / 1000);
	return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

export function formatTurnTelemetry(
	telemetry: TurnTelemetry,
	theme: Theme,
	config: {
		telemetry: {
			enabled: boolean;
			tps: boolean;
			ttft: boolean;
			duration: boolean;
			tokens: boolean;
			stalls: boolean;
		};
	},
	iconMode: IconMode,
): string {
	const glyphs = resolveGlyphs(iconMode);
	const t = config.telemetry;
	const parts: string[] = [];
	if (t.tps) {
		const value =
			telemetry.tps === null
				? "—"
				: `${formatTokensPerSecond(telemetry.tps)} tok/s`;
		parts.push(
			theme.fg(
				telemetry.tps === null ? "muted" : "accent",
				`${glyphs.speed} TPS ${value}`,
			),
		);
	}
	if (t.ttft && telemetry.ttftMs !== null) {
		parts.push(
			theme.fg(
				"text",
				`${glyphs.latency} TTFT ${formatTurnDuration(telemetry.ttftMs)}`,
			),
		);
	}
	if (t.duration) {
		parts.push(
			theme.fg(
				"success",
				`${glyphs.done} ${formatTurnDuration(telemetry.totalMs)}`,
			),
		);
	}
	if (t.tokens) {
		parts.push(
			theme.fg("accent", `${glyphs.input} ${fmtTokens(telemetry.inputTokens)}`),
		);
		parts.push(
			theme.fg("success", `${glyphs.output} ${fmtTokens(telemetry.outputTokens)}`),
		);
	}
	if (t.stalls && telemetry.stallMs > 0) {
		parts.push(
			theme.fg(
				"warning",
				`${glyphs.stall} stall ${telemetry.stallCount}x / ${formatTurnDuration(telemetry.stallMs)}`,
			),
		);
	}
	return parts.join(` ${theme.fg("dim", "|")} `);
}

export default function piMetrics(pi: ExtensionAPI): void {
	const tracker = getSpeedTracker();
	const turnAcc = new TurnMetricsAccumulator();
	const sessionAcc = new SessionMetricsAccumulator();

	// Calibration between estimated live tokens and the provider's authoritative
	// usage.output. Loaded once per session; folded at each message_end.
	const calibration = loadCalibration();

	let workTimer: ReturnType<typeof setInterval> | undefined;

	function stopWorkTimer() {
		if (workTimer) clearInterval(workTimer);
		workTimer = undefined;
	}

	function renderWorking(ctx: ExtensionContext, speed: number | null) {
		if (!isTuiContext(ctx)) return;
		const config = getConfig();
		if (!config.enabled || !config.speed.enabled || !config.speed.working) {
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
				!current.speed.enabled ||
				!current.speed.working ||
				!tracker.isStreaming
			) {
				stopWorkTimer();
				if (!current.speed.working) ctx.ui.setWorkingMessage();
				return;
			}
			// Rescale the live estimate toward the authoritative tokenizer count.
			renderWorking(ctx, calibrateTokS(tracker.liveTokS(), calibration));
		}, config.speed.renderIntervalMs);
	}

	// ---- real-time speed (data owner for the shared SpeedTracker) ----
	pi.on("session_start", () => {
		tracker.resetSession();
		sessionAcc.reset();
	});

	pi.on("message_start", (event, ctx) => {
		const config = getConfig();
		if (!config.enabled || !config.speed.enabled) {
			turnAcc.onMessageStart(event.message);
			return;
		}
		if (event.message?.role !== "assistant") return;
		tracker.startMessage();
		turnAcc.onMessageStart(event.message);
		renderWorking(ctx, tracker.lastTokS ?? tracker.liveTokS());
		startWorkTimer(ctx);
	});

	pi.on("message_update", (event, ctx) => {
		const config = getConfig();
		if (!config.enabled || !config.speed.enabled) {
			return;
		}
		if (event.message?.role !== "assistant") return;

		const ev = event.assistantMessageEvent as
			| {
					type?: string;
					delta?: string;
					partial?: { usage?: { output?: number } };
			  }
			| undefined;
		if (!ev) return;
		const isContentDelta =
			ev.type === "text_delta" || ev.type === "thinking_delta";
		const delta = ev.delta ?? "";
		if (!isContentDelta) return;

		// Feed the shared live-speed tracker.
		if (tracker.isStreaming) {
			tracker.recordDelta(delta, ev.partial?.usage?.output);
		}
		// Feed the turn metrics (first token + stall detection).
		turnAcc.onMessageUpdate(event.message, delta);
		renderWorking(ctx, tracker.liveTokS());
	});

	pi.on("message_end", (event, ctx) => {
		const config = getConfig();
		if (!config.enabled) return;
		if (event.message?.role !== "assistant") return;

		const usageOutput =
			typeof event.message.usage === "object" && event.message.usage !== null
				? ((event.message.usage as { output?: number }).output ?? 0)
				: 0;
		const stopReason = (event.message as { stopReason?: string }).stopReason;
		const completed = tracker.finishMessage(usageOutput, stopReason);
		// Fold the estimate→authoritative ratio in place so the NEXT live stream
		// is rescaled toward the provider's tokenizer count.
		if (completed && completed.estimatedTokens > 0 && usageOutput > 0) {
			foldCalibration(calibration, completed.estimatedTokens, usageOutput);
		}
		turnAcc.onMessageEnd(event.message);
		stopWorkTimer();
		renderWorking(ctx, tracker.lastTokS);
	});

	// ---- per-turn + session metrics timing ----
	pi.on("turn_start", (event) => {
		turnAcc.startTurn();
		sessionAcc.stepStart(event.turnIndex);
	});

	pi.on("turn_end", (event, ctx) => {
		// Finalize per-turn telemetry.
		const telemetry = turnAcc.resolve();
		sessionAcc.stepEnd(event.turnIndex);

		// Publish the accumulated session metrics to the store (footer reads it).
		const storeMetrics = getSessionMetrics();
		const next = sessionAcc.metrics;
		Object.assign(storeMetrics, next);

		const config = getConfig();
		if (
			telemetry &&
			config.enabled &&
			config.modules.metrics &&
			config.telemetry.enabled &&
			isTuiContext(ctx)
		) {
			const message = formatTurnTelemetry(
				telemetry,
				ctx.ui.theme,
				config,
				config.icons.mode,
			);
			if (message) ctx.ui.notify(message, "info");
		}
	});

	// ---- session metrics: tool wall time (harness toolMs) ----
	pi.on("tool_execution_start", (event) => {
		turnAcc.onToolExecutionStart();
		sessionAcc.toolCall(event.toolCallId);
	});
	pi.on("tool_execution_end", (event) => {
		sessionAcc.toolResult(event.toolCallId);
	});

	// ---- agent lifecycle ----
	pi.on("agent_end", (_event, ctx) => {
		tracker.stopMessage();
		stopWorkTimer();
		if (isTuiContext(ctx)) ctx.ui.setWorkingMessage();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopWorkTimer();
		if (isTuiContext(ctx)) ctx.ui.setWorkingMessage();
	});

	// ---- calibration debug -------
	pi.registerCommand("pi-metrics-debug", {
		description: "Show calibration between estimated and provider tokens",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
			const state = loadCalibration();
			const lines = [
				`Calibration scale: ${state.scale.toFixed(3)}`,
				`Samples: ${state.samples}`,
				"",
			];
			for (const s of state.recent.slice(-5)) {
				lines.push(
					`est ${s.estimatedTokens} vs usage ${s.usageOutput} → scale ${s.scale.toFixed(2)}`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
