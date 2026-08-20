import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ConfigStore, type Config } from "./config.js";
import { SpeedTracker } from "./speed-tracker.js";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * pi-token-speed — live output token speed (tok/s) for pi.
 *
 * - During streaming, tokens are accumulated from assistantMessageEvent
 *   text/thinking deltas, preferring the provider's usage.output deltas.
 * - Live speed uses a sliding window (default 1s) with guardrails
 *   (min reliable duration, max plausible speed).
 * - Two display slots, both configurable:
 *   - working: live speed in the streaming working indicator (on by default)
 *   - footer: session-average speed in a custom footer (on by default,
 *     footerPosition: right/line/off)
 */

const STATUS_ID = "pi-token-speed";
const STATE_SUFFIX = "pi-token-speed-enabled";
const store = new ConfigStore(`${process.env.HOME ?? ""}/.pi/agent/pi-token-speed.json`);

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatSpeed(label: string, speed: number | null): string {
	if (speed === null) return "--";
	return `${speed.toFixed(1)} ${label}`;
}

export default function piTokenSpeed(pi: ExtensionAPI): void {
	const config = store.load();
	const tracker = new SpeedTracker(config);

	let workTimer: ReturnType<typeof setInterval> | undefined;

	function stopWorkTimer() {
		if (workTimer) clearInterval(workTimer);
		workTimer = undefined;
	}

	function footerSpeed(): number | null {
		// Footer always shows the session average; live speed belongs to the working indicator.
		return tracker.sessionAvgTokS();
	}

	// ---- working indicator ----
	function renderWorking(ctx: ExtensionContext, speed: number | null) {
		if (!ctx.hasUI) return;
		if (!config.enabled || !config.working) {
			ctx.ui.setWorkingMessage();
			return;
		}
		const workingPrefix = config.workingPrefix.trim();
		const text = formatSpeed(config.label, speed);
		ctx.ui.setWorkingMessage(workingPrefix ? `${workingPrefix} ${text}` : text);
	}

	function startWorkTimer(ctx: ExtensionContext) {
		if (workTimer || !ctx.hasUI) return;
		workTimer = setInterval(() => {
			if (!config.enabled || !config.working || !tracker.isStreaming) {
				stopWorkTimer();
				if (!config.working) ctx.ui.setWorkingMessage();
				return;
			}
			renderWorking(ctx, tracker.liveTokS());
		}, config.renderIntervalMs);
	}

	// ---- custom footer (pi token stats line + right-aligned or separate-line speed) ----
	let requestRender: (() => void) | undefined;

	function setupFooter(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!config.enabled || !config.footer || config.footerPosition === "off") {
			ctx.ui.setFooter(undefined);
			requestRender = undefined;
			return;
		}
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			requestRender = () => tui.requestRender();

			const sessionTotals = () => {
				let input = 0,
					output = 0,
					cacheRead = 0,
					cacheWrite = 0,
					cost = 0;
				for (const e of ctx.sessionManager.getBranch()) {
					if (e.type === "message" && e.message.role === "assistant") {
						const usage = (e.message as AssistantMessage).usage;
						if (!usage) continue;
						input += usage.input;
						output += usage.output;
						cacheRead += usage.cacheRead;
						cacheWrite += usage.cacheWrite;
						cost += usage.cost?.total ?? 0;
					}
				}
				return { input, output, cacheRead, cacheWrite, cost };
			};

			const speedText = (speed: number | null) =>
				`${theme.fg("accent", `⚡ ${formatSpeed(config.label, speed)}`)}`;

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const totals = sessionTotals();
					const statsParts: string[] = [];
					if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
					if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
					if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
					if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
					if (totals.cost) statsParts.push(`$${totals.cost.toFixed(3)}`);

					const cusage = ctx.getContextUsage();
					if (cusage) {
						const pct = cusage.percent === null ? "?" : cusage.percent.toFixed(1);
						statsParts.push(`${pct}%/${formatTokens(cusage.contextWindow)}`);
					}
					const statsLeft = theme.fg("dim", statsParts.join(" "));

					// Right side: model (+ thinking level) + speed
					const modelName = ctx.model?.id || "no-model";
					const thinkingLevel = (
						ctx as unknown as { thinkingLevel?: string | null }
					).thinkingLevel;
					let modelRight = modelName;
					if (ctx.model?.reasoning && thinkingLevel) {
						modelRight =
							thinkingLevel === "off"
								? `${modelName} • thinking off`
								: `${modelName} • ${thinkingLevel}`;
					}
					const speedStr = speedText(footerSpeed());
					const rightSide = `${theme.fg("dim", modelRight)} ${speedStr}`;

					if (config.footerPosition === "right") {
						const leftWidth = visibleWidth(statsLeft);
						const rightWidth = visibleWidth(rightSide);
						if (leftWidth + rightWidth + 2 > width) {
							return [truncateToWidth(`${statsLeft}  ${rightSide}`, width, "")];
						}
						const pad = " ".repeat(width - leftWidth - rightWidth);
						return [truncateToWidth(`${statsLeft}${pad}${rightSide}`, width, "")];
					}
					return [statsLeft, truncateToWidth(`${speedStr}`, width, "")];
				},
			};
		});
	}

	// ---- events ----
	pi.on("agent_start", async (_event, ctx) => {
		setupFooter(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		stopWorkTimer();
		store.load();
		Object.assign(config, store.current);
		tracker.resetSession();
		setupFooter(ctx);
	});

	pi.on("message_start", (event, ctx) => {
		if (!config.enabled || event.message?.role !== "assistant") return;
		tracker.startMessage();
		renderWorking(ctx, tracker.lastTokS ?? tracker.liveTokS());
		startWorkTimer(ctx);
	});

	pi.on("message_update", (event, ctx) => {
		if (!config.enabled || event.message?.role !== "assistant") return;
		if (!tracker.isStreaming) return;
		const ev = event.assistantMessageEvent as {
			type?: string;
			delta?: string;
			partial?: { usage?: { output?: number } };
		} | undefined;
		if (!ev) return;
		if (ev.type === "text_delta" || ev.type === "thinking_delta") {
			tracker.recordDelta(ev.delta ?? "", ev.partial?.usage?.output);
		}
		renderWorking(ctx, tracker.liveTokS());
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message?.role !== "assistant") return;
		const usageOutput =
			typeof event.message.usage === "object" && event.message.usage !== null
				? (event.message.usage as { output?: number }).output ?? 0
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
		if (ctx.hasUI) ctx.ui.setWorkingMessage();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopWorkTimer();
		if (ctx.hasUI) {
			ctx.ui.setFooter(undefined);
			ctx.ui.setStatus(STATUS_ID, undefined);
		}
	});

	// Apply a config change: persist it, then re-render the custom footer immediately.
	function commit(next: Config): void {
		store.update(next);
		Object.assign(config, store.current);
		requestRender?.();
	}

	// Cycle footer position: right → line → off. "off" restores pi's built-in footer.
	function toggleFooterPosition(ctx: ExtensionContext): void {
		const order = ["right", "line", "off"] as const;
		const next = order[(order.indexOf(config.footerPosition) + 1) % order.length];
		commit({ ...config, footerPosition: next });
		setupFooter(ctx);
	}

	// ---- commands ----
	// No argument opens the interactive settings panel.
	// Subcommands: working / position / stats / toggle
	pi.registerCommand("pi-token-speed", {
		description: "pi-token-speed settings panel; subcommands: working / position / stats",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [cmdRaw] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
			const cmd = cmdRaw ?? "";
			const extCtx = ctx as unknown as ExtensionContext;

			if (cmd === "stats") {
				const avg = tracker.sessionAvgTokS();
				const last = tracker.lastTokS;
				ctx.ui.notify(
					`pi-token-speed — session avg: ${avg === null ? "--" : `${avg.toFixed(1)} tok/s`}, last message: ${last === null ? "--" : `${last.toFixed(1)} tok/s`}, window: ${config.slidingWindowMs}ms, footer: ${config.footerPosition}`,
					"info",
				);
				return;
			}

			if (cmd === "working") {
				commit({ ...config, working: !config.working });
				if (!config.working && ctx.hasUI) ctx.ui.setWorkingMessage();
				else renderWorking(extCtx, tracker.lastTokS);
				ctx.ui.notify(`pi-token-speed working display: ${config.working ? "on" : "off"}`, "info");
				return;
			}

			if (cmd === "position") {
				toggleFooterPosition(extCtx);
				ctx.ui.notify(`pi-token-speed footer position: ${config.footerPosition}`, "info");
				return;
			}

			if (cmd === "toggle") {
				commit({ ...config, enabled: !config.enabled });
				if (!config.enabled) {
					stopWorkTimer();
					if (ctx.hasUI) {
						ctx.ui.setFooter(undefined);
						ctx.ui.setWorkingMessage();
					}
				} else {
					setupFooter(extCtx);
				}
				ctx.ui.notify(`pi-token-speed ${config.enabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			// No argument: interactive settings panel (loops until cancelled)
			while (true) {
				const posLabel = (p: string) =>
					p === "right" ? "Right-aligned" : p === "line" ? "Own line" : "Off";
				const choice = await ctx.ui.select(
					`⚡ pi-token-speed settings (enabled: ${config.enabled ? "yes" : "no"})`,
					[
						`Enabled: ${config.enabled ? "yes" : "no"}`,
						`Working indicator: ${config.working ? "on" : "off"}`,
						`Footer position: ${posLabel(config.footerPosition)}`,
						`Speed label: ${config.label}`,
						`Sliding window: ${config.slidingWindowMs}ms`,
						"-- exit --",
					],
				);
				if (!choice || choice.startsWith("--")) return;

				if (choice.startsWith("Enabled:")) {
					commit({ ...config, enabled: !config.enabled });
					if (!config.enabled) {
						stopWorkTimer();
						if (ctx.hasUI) {
							ctx.ui.setFooter(undefined);
							ctx.ui.setWorkingMessage();
						}
					} else {
						setupFooter(extCtx);
					}
					continue;
				}
				if (choice.startsWith("Working indicator:")) {
					commit({ ...config, working: !config.working });
					if (!config.working && ctx.hasUI) ctx.ui.setWorkingMessage();
					continue;
				}
				if (choice.startsWith("Footer position:")) {
					toggleFooterPosition(extCtx);
					ctx.ui.notify(`pi-token-speed footer position: ${config.footerPosition}`, "info");
					continue;
				}
				if (choice.startsWith("Speed label:")) {
					const value = await ctx.ui.input("Speed label (e.g. tok/s)", config.label);
					if (value && value.trim()) {
						commit({ ...config, label: value.trim() });
					}
					continue;
				}
				if (choice.startsWith("Sliding window:")) {
					const value = await ctx.ui.input("Sliding window ms (e.g. 1000)", String(config.slidingWindowMs));
					if (value) {
						const ms = Number(value.trim());
						if (Number.isFinite(ms) && ms > 0) {
							commit({ ...config, slidingWindowMs: ms });
						}
					}
					continue;
				}
			}
		},
	});
}
export { STATE_SUFFIX };