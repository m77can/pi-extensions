import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { PiTuiConfig } from "../../shared/config.js";
import type { IconGlyphs } from "../../shared/icons.js";
import {
	resolveGlyphs,
	resolveIconMode,
	runtimeSymbol,
} from "../../shared/icons.js";
import type { GitStatus } from "../../shared/git.js";
import { emptyGitStatus, readGitStatus } from "../../shared/git.js";
import type { RuntimeInfo } from "../../shared/runtime.js";
import { readRuntimeInfo } from "../../shared/runtime.js";
import {
	alignRight,
	basenamePath,
	cacheHitColor,
	effortColor,
	fitSegmentsByPriority,
	fmtTokens,
	formatCwd,
	formatDuration,
	formatProviderLabel,
	providerColor,
	sanitizeStatus,
	stressColor,
	truncateBranch,
	truncatePath,
	type PrioritizedSegment,
} from "../../shared/utils.js";
import type {
	FooterState,
	ModelMeta,
	UsageTotals,
} from "../../shared/state.js";
import {
	getUsageTotals,
	getModelMeta,
	createInitialState,
	invalidateUsageCache,
} from "../../shared/state.js";
import { SessionLifecycle } from "../../shared/session-lifecycle.js";
import {
	getConfig,
	subscribeConfig,
	setRequestFooterRender,
	requestFooterRender,
} from "../../shared/pi-tui-store.js";

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const m = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (m === undefined || m === "tui");
	} catch {
		return false;
	}
}

function renderBar(
	theme: Theme,
	pct: number,
	barWidth: number,
	ascii: boolean,
): string {
	const filled = Math.max(
		0,
		Math.min(barWidth, Math.round((pct / 100) * barWidth)),
	);
	const empty = barWidth - filled;
	const color = stressColor(pct);
	const filledCell = ascii ? "#" : "█";
	const emptyCell = ascii ? "-" : "░";
	return (
		theme.fg("dim", "[") +
		theme.fg(color, filledCell.repeat(filled)) +
		theme.fg("dim", emptyCell.repeat(empty)) +
		theme.fg("dim", "]")
	);
}

function renderContextCompact(
	theme: Theme,
	ctx: ExtensionContext,
	glyphs: IconGlyphs,
): string {
	const contextUsage = ctx.getContextUsage();
	const contextWindow =
		contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (contextWindow <= 0) return "";
	const contextPct = contextUsage?.percent ?? 0;
	return `${theme.fg(stressColor(contextPct), glyphs.context)} ${theme.fg(stressColor(contextPct), `${contextPct.toFixed(1)}%`)}`;
}

function renderGitSegment(
	theme: Theme,
	git: GitStatus,
	glyphs: IconGlyphs,
	segments: PiTuiConfig["footerSegments"],
	maxBranchLen = 20,
): string {
	const parts: string[] = [];
	if (segments.gitBranch) {
		if (git.branch) {
			parts.push(theme.fg("mdLink", glyphs.git));
			parts.push(theme.fg("mdLink", truncateBranch(git.branch, maxBranchLen)));
		} else if (git.commit?.detached) {
			parts.push(theme.fg("warning", glyphs.git));
			parts.push(theme.fg("warning", "HEAD"));
			if (git.commit.oid) {
				const shortHash = git.commit.oid.slice(0, 7);
				const tag = git.commit.tag ? ` ${git.commit.tag}` : "";
				parts.push(theme.fg("dim", `${shortHash}${tag}`));
			}
		}
	}

	if (segments.gitStatus) {
		const statusIcons: string[] = [];
		const addStatus = (count: number, glyph: string, color: ThemeColor) => {
			if (count > 0) statusIcons.push(theme.fg(color, `${glyph}${count}`));
		};
		addStatus(git.conflicted, glyphs.conflicted, "error");
		addStatus(git.deleted, glyphs.deleted, "error");
		addStatus(git.modified, glyphs.modified, "warning");
		addStatus(git.renamed, glyphs.renamed, "warning");
		addStatus(git.staged, glyphs.staged, "success");
		addStatus(git.untracked, glyphs.untracked, "muted");
		addStatus(git.stashed, glyphs.stashed, "muted");

		if (git.ahead > 0 && git.behind > 0) {
			statusIcons.push(
				theme.fg("warning", `${glyphs.diverged}${git.ahead}/${git.behind}`),
			);
		} else if (git.ahead > 0) {
			statusIcons.push(theme.fg("success", `${glyphs.ahead}${git.ahead}`));
		} else if (git.behind > 0) {
			statusIcons.push(theme.fg("warning", `${glyphs.behind}${git.behind}`));
		}

		const statusBlock = statusIcons.join(" ");
		if (statusBlock) {
			parts.push(`${theme.fg("dim", "[")}${statusBlock}${theme.fg("dim", "]")}`);
		}
	}

	return parts.join(" ");
}

function renderRuntimeSegment(
	theme: Theme,
	runtime: RuntimeInfo | null,
	iconMode: PiTuiConfig["icons"]["mode"],
): string {
	if (!runtime) return "";
	const symbol = theme.fg("success", runtimeSymbol(runtime.name, iconMode));
	const version = runtime.version ? theme.fg("muted", runtime.version) : "";
	const label = [symbol, version].filter(Boolean).join(" ");
	return label;
}

function renderTimerSegment(
	theme: Theme,
	state: FooterState,
	glyphs: IconGlyphs,
): string {
	if (state.workingSince !== undefined) {
		return `${theme.fg("accent", glyphs.working)} ${theme.fg("dim", "working")} ${theme.fg("accent", formatDuration(Date.now() - state.workingSince))}`;
	}
	if (state.lastDoneIn !== undefined) {
		return `${theme.fg("success", glyphs.done)} ${theme.fg("success", "done")} ${theme.fg("text", formatDuration(state.lastDoneIn))}`;
	}
	return "";
}

function renderContextBar(
	theme: Theme,
	ctx: ExtensionContext,
	width: number,
	glyphs: IconGlyphs,
	iconMode: PiTuiConfig["icons"]["mode"],
): string {
	const contextUsage = ctx.getContextUsage();
	const contextWindow =
		contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextTokens = contextUsage?.tokens ?? 0;
	const contextPct = contextUsage?.percent ?? 0;

	if (contextWindow <= 0) return "";

	const pctText = theme.fg(stressColor(contextPct), `${contextPct.toFixed(1)}%`);
	const ctxText = `${theme.fg("text", fmtTokens(contextTokens))}${theme.fg("dim", "/")}${theme.fg("text", fmtTokens(contextWindow))}`;
	const contextIcon = theme.fg(stressColor(contextPct), glyphs.context);
	const reserved =
		visibleWidth(contextIcon) +
		visibleWidth(pctText) +
		visibleWidth(ctxText) +
		5 +
		2;
	const barWidth = Math.max(4, Math.min(12, width - reserved));
	return `${contextIcon} ${renderBar(theme, contextPct, barWidth, resolveIconMode(iconMode) === "ascii")} ${pctText} ${theme.fg("dim", "·")} ${ctxText}`;
}

function renderStatsBlock(
	theme: Theme,
	totals: UsageTotals,
	glyphs: IconGlyphs,
	segments: PiTuiConfig["footerSegments"],
): string {
	const stats: string[] = [];
	if (segments.tokens) {
		stats.push(theme.fg("accent", `${glyphs.input} ${fmtTokens(totals.input)}`));
		stats.push(
			theme.fg("success", `${glyphs.output} ${fmtTokens(totals.output)}`),
		);
		const hasCacheTokens = totals.cacheRead > 0 || totals.cacheWrite > 0;
		if (hasCacheTokens && totals.latestCacheHitRate !== undefined) {
			stats.push(
				theme.fg(
					cacheHitColor(totals.latestCacheHitRate),
					`${glyphs.cacheHit} ${totals.latestCacheHitRate.toFixed(1)}%`,
				),
			);
		}
	}

	return stats.join(` ${theme.fg("dim", "|")} `);
}

function renderExtensionStatusLines(
	theme: Theme,
	extensionStatuses: ReadonlyMap<string, string>,
	glyphs: IconGlyphs,
	width: number,
): string[] {
	const statuses = Array.from(extensionStatuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatus(text))
		.filter((text) => text.length > 0);
	if (statuses.length === 0) return [];

	const separator = ` ${theme.fg("dim", "|")} `;
	const statusText = statuses
		.map((status) => theme.fg("muted", status))
		.join(separator);
	const line = `${theme.fg("mdLink", glyphs.extensions)} ${statusText}`;
	return wrapTextWithAnsi(line, width);
}

export function installFooter(
	ctx: ExtensionContext,
	getState: () => FooterState,
	getMeta: () => ModelMeta,
	scheduleGitRefresh: () => void,
): () => void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		setRequestFooterRender(() => tui.requestRender());
		const unsubBranch = footerData.onBranchChange(() => {
			scheduleGitRefresh();
			tui.requestRender();
		});

		return {
			dispose() {
				unsubBranch();
				setRequestFooterRender(undefined);
			},
			invalidate() {},
			render(width: number): string[] {
				if (width <= 0) return [""];
				const state = getState();
				const config = getConfig();
				const glyphs = resolveGlyphs(config.icons.mode);
				const segments = config.footerSegments;
				const meta = getMeta();

				const totals = getUsageTotals(ctx);

				const leftParts: PrioritizedSegment[] = [];
				if (segments.cwd) {
					const maxCwd = Math.min(30, Math.max(10, Math.floor(width * 0.4)));
					const cwd = formatCwd(ctx.sessionManager.getCwd());
					const cwdPrefix = `${theme.fg("mdLink", glyphs.cwd)} `;
					const accent = (text: string) => theme.fg("accent", text);
					leftParts.push({
						text: `${cwdPrefix}${accent(truncatePath(cwd, maxCwd))}`,
						compactText: `${cwdPrefix}${accent(truncatePath(basenamePath(cwd), maxCwd))}`,
						priority: 0,
						truncate: (_text, maxWidth, ellipsis) => {
							const pathWidth = maxWidth - visibleWidth(cwdPrefix);
							if (pathWidth <= visibleWidth(ellipsis)) {
								return truncateToWidth(
									`${cwdPrefix}${accent(basenamePath(cwd))}`,
									maxWidth,
									ellipsis,
								);
							}
							return `${cwdPrefix}${accent(truncatePath(basenamePath(cwd), pathWidth))}`;
						},
					});
				}
				if (segments.sessionName) {
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) {
						leftParts.push({
							text: `${theme.fg("dim", glyphs.session)} ${theme.fg("text", truncateToWidth(sessionName, 24, theme.fg("dim", "...")))}`,
							priority: 2,
						});
					}
				}
				const gitSeg = renderGitSegment(theme, state.git, glyphs, segments);
				if (gitSeg) leftParts.push({ text: gitSeg, priority: 3 });
				if (segments.runtime) {
					const runtimeSeg = renderRuntimeSegment(
						theme,
						state.runtime,
						config.icons.mode,
					);
					if (runtimeSeg) leftParts.push({ text: runtimeSeg, priority: 4 });
				}
				const timerSeg = renderTimerSegment(theme, state, glyphs);
				if (timerSeg) leftParts.push({ text: timerSeg, priority: 1 });

				let contextText = "";
				let contextCompact: string | undefined;
				if (segments.context) {
					contextText = renderContextBar(
						theme,
						ctx,
						width,
						glyphs,
						config.icons.mode,
					);
					const compact = renderContextCompact(theme, ctx, glyphs);
					if (compact && visibleWidth(compact) < visibleWidth(contextText)) {
						contextCompact = compact;
					}
				}
				const allParts: PrioritizedSegment[] = [...leftParts];
				if (contextText) {
					allParts.push({
						text: contextText,
						compactText: contextCompact,
						priority: 4,
					});
				}

				const fitted = fitSegmentsByPriority(
					allParts,
					width,
					theme.fg("dim", "..."),
				);
				const fittedContext = contextText ? (fitted.pop() ?? "") : "";
				const line1 = alignRight(fitted.join(" "), fittedContext, width, theme);

				const modelParts: string[] = [];
				modelParts.push(theme.fg("mdLink", glyphs.model));
				if (meta.provider && meta.provider !== "Unknown") {
					modelParts.push(
						theme.fg(providerColor(ctx.model?.provider ?? "none"), meta.provider),
					);
				}
				modelParts.push(theme.fg("text", meta.model));
				if (meta.effort && meta.effort !== "off") {
					modelParts.push(
						theme.fg(effortColor(meta.effort), `${glyphs.thinking} ${meta.effort}`),
					);
				}
				const modelBlock = modelParts.join(theme.fg("dim", " · "));

				const statsBlock = renderStatsBlock(theme, totals, glyphs, segments);

				const line2 = alignRight(modelBlock, statsBlock, width, theme);

				const mainLines = [line1, line2].map((line) =>
					truncateToWidth(line, width, theme.fg("dim", "...")),
				);
				return segments.extensionStatuses
					? [
							...mainLines,
							...renderExtensionStatusLines(
								theme,
								footerData.getExtensionStatuses(),
								glyphs,
								width,
							),
						]
					: mainLines;
			},
		};
	});

	return () => {
		ctx.ui.setFooter(undefined);
	};
}

export default function piFooter(pi: ExtensionAPI): void {
	const sessionLifecycle = new SessionLifecycle();
	const state: FooterState = createInitialState();
	// Whole-session harness metrics are owned by pi-metrics (feeds the store);
	// this footer only renders usage totals from session entries. Live speed
	// lives in the working indicator (pi-metrics), not the footer.

	let active = false;
	let lastCtx: ExtensionContext | undefined;
	let cleanupFooter: (() => void) | undefined;
	let workingTimer: ReturnType<typeof setInterval> | undefined;

	const getMeta = (ctx: ExtensionContext): ModelMeta =>
		getModelMeta(ctx, () =>
			sessionLifecycle.isCurrent() ? pi.getThinkingLevel() : "off",
		);

	const scheduleGitRefresh = async (ctx: ExtensionContext) => {
		if (!sessionLifecycle.isCurrent()) return;
		const segs = getConfig().footerSegments;
		if (!segs.gitBranch && !segs.gitStatus && !segs.gitCommit) {
			state.git = emptyGitStatus();
			requestFooterRender();
			return;
		}
		const generation = sessionLifecycle.currentGeneration();
		const cwd = ctx.cwd;
		const git = await readGitStatus(cwd, {
			readCommit: true,
			readTag: segs.gitCommit,
			readCounts: segs.gitStatus,
		});
		if (!sessionLifecycle.isCurrent(generation)) return;
		state.git = git;
		requestFooterRender();
	};

	const refreshRuntime = async (ctx: ExtensionContext) => {
		if (!sessionLifecycle.isCurrent()) return;
		const generation = sessionLifecycle.currentGeneration();
		const cwd = ctx.cwd;
		const runtime = await readRuntimeInfo(cwd);
		if (!sessionLifecycle.isCurrent(generation)) return;
		state.runtime = runtime;
		requestFooterRender();
	};

	const startWorkingTimer = () => {
		stopWorkingTimer();
		const tick = () => {
			if (sessionLifecycle.isCurrent() && active) requestFooterRender();
		};
		workingTimer = setInterval(tick, 250);
		workingTimer.unref?.();
	};

	const stopWorkingTimer = () => {
		if (workingTimer) {
			clearInterval(workingTimer);
			workingTimer = undefined;
		}
	};

	const setupFooter = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		const c = getConfig();
		if (!c.enabled || !c.modules.footer) {
			cleanupFooter?.();
			cleanupFooter = undefined;
			active = false;
			return;
		}
		if (!active) {
			cleanupFooter = installFooter(
				ctx,
				() => state,
				() => getMeta(ctx),
				() => {
					void scheduleGitRefresh(ctx);
				},
			);
			active = true;
		}
	};

	const uninstall = () => {
		cleanupFooter?.();
		cleanupFooter = undefined;
		active = false;
	};

	subscribeConfig(() => {
		requestFooterRender();
		if (lastCtx) setupFooter(lastCtx);
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionLifecycle.start();
		lastCtx = ctx;
		state.sessionStartEpoch = Date.now();
		state.workingSince = undefined;
		state.lastDoneIn = undefined;
		invalidateUsageCache();
		// Speed data lifecycle (resetSession) is owned by the pi-speed module.
		setupFooter(ctx);
		if (isTuiContext(ctx)) {
			void scheduleGitRefresh(ctx);
			void refreshRuntime(ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		sessionLifecycle.shutdown();
		stopWorkingTimer();
		uninstall();
		lastCtx = undefined;
	});

	pi.on("agent_start", () => {
		if (!sessionLifecycle.isCurrent()) return;
		state.workingSince = Date.now();
		state.lastDoneIn = undefined;
		startWorkingTimer();
	});

	pi.on("agent_end", () => {
		if (!sessionLifecycle.isCurrent()) return;
		stopWorkingTimer();
		if (state.workingSince !== undefined) {
			state.lastDoneIn = Date.now() - state.workingSince;
			state.workingSince = undefined;
		}
		requestFooterRender();
	});

	pi.on("message_end", () => {
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		requestFooterRender();
	});

	pi.on("turn_end", () => {
		if (!sessionLifecycle.isCurrent()) return;
		// Speed data lifecycle (stopMessage) is owned by the pi-speed module.
	});
}
