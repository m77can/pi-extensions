import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ConfigStore, DEFAULT_CONFIG } from "./config.js";
import { SpeedTracker } from "./speed-tracker.js";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * pi-token-speed —— pi 扩展：实时输出 token 速度（tok/s）
 *
 * - 流式期间从 assistantMessageEvent 的 text/thinking delta 累计 token，
 *   优先使用 provider 报告的 usage.output 增量。
 * - 瞬时速度用滑动窗口（默认 1s）估算，带最短时长/最大速度消毒护栏。
 * - 两个展示位都可在 config 中开关：
 *   - working: 流式时的 Working 指示器（默认开）
 *   - footer: 底部 footer 速度（默认开，footerPosition: right/line/off 控制位置）
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
		if (tracker.isStreaming) {
			const live = tracker.liveTokS();
			if (live !== null && live > 0) return live;
		}
		return tracker.sessionAvgTokS();
	}

	// ---- working 指示器 ----
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

	// ---- 自定义 footer（保留 pi 内置统计行 + 速度右对齐/独立行）----
	function setupFooter(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!config.enabled || !config.footer || config.footerPosition === "off") {
			ctx.ui.setFooter(undefined);
			return;
		}
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

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

					// 右侧：model (+ thinking) + 速度
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
					return [
						statsLeft,
						truncateToWidth(`${speedStr}`, width, ""),
					];
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

	// ---- 命令 ----
	pi.registerCommand("pi-token-speed", {
		description:
			"Configure pi-token-speed: [none] toggle on/off, working toggle working indicator, position cycle footer position, stats show stats",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [cmdRaw] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
			const cmd = cmdRaw ?? "toggle";
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
				store.update({ ...config, working: !config.working });
				Object.assign(config, store.current);
				if (!config.working && ctx.hasUI) ctx.ui.setWorkingMessage();
				else renderWorking(extCtx, tracker.lastTokS);
				ctx.ui.notify(`pi-token-speed working display: ${config.working ? "on" : "off"}`, "info");
				return;
			}
			if (cmd === "position") {
				const order = ["right", "line", "off"] as const;
				const next = order[(order.indexOf(config.footerPosition) + 1) % order.length];
				store.update({ ...config, footerPosition: next });
				Object.assign(config, store.current);
				setupFooter(extCtx);
				ctx.ui.notify(`pi-token-speed footer position: ${next}`, "info");
				return;
			}
			// toggle enabled
			store.update({ ...config, enabled: !config.enabled });
			Object.assign(config, store.current);
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
		},
	});
}
export { STATE_SUFFIX };