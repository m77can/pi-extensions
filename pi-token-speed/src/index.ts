import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ConfigStore, DEFAULT_CONFIG } from "./config.js";
import { SpeedTracker } from "./speed-tracker.js";

/**
 * pi-token-speed —— pi 扩展：实时输出 token 速度（tok/s）
 *
 * - 流式期间从 assistantMessageEvent 的 text/thinking delta 累计 token，
 *   优先使用 provider 报告的 usage.output 增量。
 * - 瞬时速度用滑动窗口（默认 1s）估算，带最短时长/最大速度消毒护栏。
 * - 流式速度打到 setWorkingMessage，footer 发布会话平均速度到
 *   setStatus("pi-token-speed")，供 pi-footer 等状态行扩展消费。
 *
 * 复杂度说明：单文件、无持久化 UI。文档阅读优先，写文件前说明计划；
 * 如果未来报"按钮点击怎么区分边框标题和按钮文字"，错误在 selectors 而非 UI。
 */

const STATUS_ID = "pi-token-speed";
const STATE_SUFFIX = "pi-token-speed-enabled";
const store = new ConfigStore(
	`${process.env.HOME ?? ""}/.pi/agent/pi-token-speed.json`,
);

function formatSpeed(label: string, speed: number | null): string {
	if (speed === null) return "--";
	return `${speed.toFixed(1)} ${label}`;
}

function renderFooterTokS(label: string, prefix: string, speed: number | null): string {
	const text = formatSpeed(label, speed);
	const footerPrefix = prefix.trim();
	return footerPrefix ? `${footerPrefix} ${text}` : text;
}

function renderWorkingTokS(label: string, prefix: string, speed: number | null): string {
	const workingPrefix = prefix.trim();
	const speedText = formatSpeed(label, speed);
	return workingPrefix ? `${workingPrefix} ${speedText}` : speedText;
}

export default function piTokenSpeed(pi: ExtensionAPI): void {
	const config = store.load();
	const tracker = new SpeedTracker(config);

	let footerTimer: ReturnType<typeof setInterval> | undefined;
	let workingTimer: ReturnType<typeof setInterval> | undefined;

	function clearTimers() {
		if (footerTimer) clearInterval(footerTimer);
		if (workingTimer) clearInterval(workingTimer);
		footerTimer = undefined;
		workingTimer = undefined;
	}

	function updateStatus(ctx: ExtensionContext, speed: number | null) {
		if (!ctx.hasUI) return;
		if (!config.enabled || !config.footer) {
			ctx.ui.setStatus(STATUS_ID, undefined);
			return;
		}
		const label = config.label || DEFAULT_CONFIG.label;
		ctx.ui.setStatus(STATUS_ID, renderFooterTokS(label, config.footerPrefix, speed));
	}

	function renderWorking(ctx: ExtensionContext, speed: number | null) {
		if (!ctx.hasUI) return;
		if (!config.enabled || !config.working) {
			ctx.ui.setWorkingMessage();
			return;
		}
		const label = config.label || DEFAULT_CONFIG.label;
		ctx.ui.setWorkingMessage(renderWorkingTokS(label, config.workingPrefix, speed));
	}

	function startWorkingAnimation(ctx: ExtensionContext) {
		if (workingTimer || !ctx.hasUI) return;
		workingTimer = setInterval(() => {
			if (!config.enabled) {
				clearTimers();
				ctx.ui.setWorkingMessage();
				return;
			}
			renderWorking(ctx, tracker.liveTokS());
		}, config.renderIntervalMs);
	}

	function startFooterAnimation(ctx: ExtensionContext) {
		if (footerTimer || !ctx.hasUI) return;
		footerTimer = setInterval(() => {
			if (!config.enabled) {
				clearTimers();
				ctx.ui.setStatus(STATUS_ID, undefined);
				return;
			}
			updateStatus(ctx, tracker.sessionAvgTokS());
		}, config.renderIntervalMs);
	}

	pi.on("session_start", async (_event, ctx) => {
		clearTimers();
		store.load();
		Object.assign(config, store.current);
		tracker.resetSession();
		updateStatus(ctx, null);
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!config.enabled) return;
		updateStatus(ctx, null);
	});

	pi.on("turn_start", async (_event, _ctx) => {
		// nothing; speeds are message-scoped by design
	});

	pi.on("message_start", async (event, ctx) => {
		if (!config.enabled || event.message?.role !== "assistant") return;
		tracker.startMessage();
		renderWorking(ctx, tracker.lastTokS ?? tracker.liveTokS());
		startWorkingAnimation(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
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

	pi.on("message_end", async (event, ctx) => {
		if (event.message?.role !== "assistant") return;
		const usageOutput =
			typeof event.message.usage === "object" && event.message.usage !== null
				? (event.message.usage as { output?: number }).output ?? 0
				: 0;
		const stopReason = (event.message as { stopReason?: string }).stopReason;
		tracker.finishMessage(usageOutput, stopReason);
		if (config.enabled && config.footer) {
			updateStatus(ctx, tracker.sessionAvgTokS());
			startFooterAnimation(ctx);
		}
		// working message may keep showing last stable speed until next turn
		renderWorking(ctx, tracker.lastTokS);
	});

	pi.on("turn_end", async () => {
		tracker.stopMessage();
		if (workingTimer) clearInterval(workingTimer);
		workingTimer = undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		tracker.stopMessage();
		clearTimers();
		if (ctx.hasUI) ctx.ui.setWorkingMessage();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearTimers();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
	});

	// /pi-token-speed 命令：toggle 启用状态；/pi-token-speed stats 查看统计
	pi.registerCommand("pi-token-speed", {
		description: "Toggle the pi-token-speed extension; /pi-token-speed stats shows session stats",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			let [cmd] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
			if (!cmd) cmd = "toggle";
			if (cmd === "stats") {
				const avg = tracker.sessionAvgTokS();
				const last = tracker.lastTokS;
				const cfg = config;
				ctx.ui.notify(
					`pi-token-speed stats — session avg: ${avg === null ? "--" : avg.toFixed(1)} tok/s, last message: ${last === null ? "--" : last.toFixed(1)} tok/s, window: ${cfg.slidingWindowMs}ms`,
					"info",
				);
				return;
			}
			// toggle
			store.update({ ...config, enabled: !config.enabled });
			Object.assign(config, store.current);
			if (!config.enabled) {
				if (ctx.hasUI) {
					ctx.ui.setStatus(STATUS_ID, undefined);
					ctx.ui.setWorkingMessage();
				}
			} else {
				updateStatus(ctx as unknown as ExtensionContext, tracker.sessionAvgTokS());
			}
			ctx.ui.notify(`pi-token-speed ${config.enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}

export { STATE_SUFFIX };