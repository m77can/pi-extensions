import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	Key,
	matchesKey,
	SelectList,
	type SelectItem,
	type TUI,
	Text,
} from "@earendil-works/pi-tui";
import type { PiTuiConfig, SettingsLanguage } from "../../shared/config.js";
import {
	getConfig,
	updateConfig,
	subscribeConfig,
	requestFooterRender,
	getEditorControls,
} from "../../shared/pi-tui-store.js";

const WHEEL_SCROLL_PRESETS = [1, 4, 7, 10] as const;
const SPEED_LABEL_PRESETS = ["tok/s", "tokens/s", "tps"] as const;
const SLIDING_WINDOW_PRESETS = [250, 500, 1000, 2000, 5000] as const;
const RENDER_INTERVAL_PRESETS = [100, 250, 500, 1000] as const;
const MAX_DISPLAY_SPEED_PRESETS = [100, 250, 500, 1000, 2000] as const;
const COUNT_STRATEGY_PRESETS = ["estimate", "direct", "chars"] as const;

interface SettingItem {
	id: string;
	label: string;
	currentValue: string;
}

type Tab = "features" | "icons" | "segments" | "speed" | "telemetry";

const TABS: Tab[] = ["features", "icons", "segments", "speed", "telemetry"];

const COPY = {
	en: {
		title: "Pi TUI Settings",
		tabs: {
			features: "General",
			icons: "Appearance",
			segments: "Footer",
			speed: "Speed",
			telemetry: "Telemetry",
		},
		hint:
			"Tab/Shift+Tab/←/→: tabs · ↑/↓: move · Enter/Space: change · Esc/q: close",
		labels: {
			enabled: "Enabled",
			language: "Language",
			wheelScrollLines: "Mouse wheel speed",
			cursorStyle: "Cursor style",
			iconMode: "Icon mode",
			cwd: "CWD",
			sessionName: "Session name",
			gitBranch: "Git branch",
			gitStatus: "Git status",
			gitCommit: "Git commit (detached)",
			runtime: "Runtime",
			context: "Context bar",
			tokens: "Tokens",
			cost: "Cost",
			extensionStatuses: "Extension status line",
			speedSegment: "Speed in footer",
			cacheHit: "Cache hit",
			speedWorking: "Working indicator",
			speedLabel: "Speed label",
			speedSlidingWindow: "Sliding window",
			speedRenderInterval: "Render interval",
			speedMaxDisplay: "Max display speed",
			speedProviderTokens: "Use provider tokens",
			speedCountStrategy: "Count strategy",
			totalDuration: "Total duration",
			tokenCounts: "Token counts",
			stallDetails: "Stall details",
			costRate: "Cost rate",
		},
		values: {
			on: "On",
			off: "Off",
			languages: { en: "English", zh: "简体中文" },
			wheelLines: (count: number) =>
				`${count} ${count === 1 ? "line" : "lines"} / notch`,
			cursorStyles: { block: "Block", bar: "Bar", underline: "Underline" },
			icons: { auto: "Auto", nerd: "Nerd", ascii: "ASCII" },
			ms: (count: number) => `${count}ms`,
			countStrategies: { estimate: "Estimate", direct: "Direct", chars: "Chars÷4" },
		},
	},
	zh: {
		title: "Pi TUI 设置",
		tabs: {
			features: "常规",
			icons: "外观",
			segments: "Footer",
			speed: "速度",
			telemetry: "遥测",
		},
		hint: "Tab/Shift+Tab/←/→：切页 · ↑/↓：移动 · Enter/Space：更改 · Esc/q：关闭",
		labels: {
			enabled: "启用",
			language: "语言",
			wheelScrollLines: "鼠标滚轮速度",
			cursorStyle: "光标样式",
			iconMode: "图标模式",
			cwd: "当前目录",
			sessionName: "会话名",
			gitBranch: "Git 分支",
			gitStatus: "Git 状态",
			gitCommit: "Git 提交（分离 HEAD）",
			runtime: "运行环境",
			context: "上下文栏",
			tokens: "Token",
			cost: "费用",
			extensionStatuses: "扩展状态行",
			speedSegment: "Footer 中的速度",
			cacheHit: "缓存命中",
			speedWorking: "工作指示器",
			speedLabel: "速度标签",
			speedSlidingWindow: "滑动窗口",
			speedRenderInterval: "刷新间隔",
			speedMaxDisplay: "最大显示速度",
			speedProviderTokens: "使用 provider 令牌",
			speedCountStrategy: "计数策略",
			totalDuration: "总耗时",
			tokenCounts: "Token 数量",
			stallDetails: "停顿详情",
			costRate: "费用速率",
		},
		values: {
			on: "开启",
			off: "关闭",
			languages: { en: "English", zh: "简体中文" },
			wheelLines: (count: number) => `每格 ${count} 行`,
			cursorStyles: { block: "块", bar: "竖线", underline: "下划线" },
			icons: { auto: "自动", nerd: "Nerd", ascii: "ASCII" },
			ms: (count: number) => `${count}ms`,
			countStrategies: { estimate: "估算", direct: "直接", chars: "字符÷4" },
		},
	},
} as const;

type SettingsCopy = (typeof COPY)[SettingsLanguage];

function cycleValue<T>(current: T, presets: readonly T[]): T {
	const idx = presets.indexOf(current);
	return presets[(idx + 1) % presets.length] ?? presets[0]!;
}

function toggleSetting(
	config: PiTuiConfig,
	key: keyof PiTuiConfig["footerSegments"],
): PiTuiConfig {
	return {
		...config,
		footerSegments: {
			...config.footerSegments,
			[key]: !config.footerSegments[key],
		},
	};
}

function toggleSpeedSetting(
	config: PiTuiConfig,
	key: "enabled" | "working" | "useProviderTokens",
): PiTuiConfig {
	return {
		...config,
		speed: { ...config.speed, [key]: !config.speed[key] },
	};
}

function cycleIconMode(config: PiTuiConfig): PiTuiConfig {
	return {
		...config,
		icons: {
			mode: cycleValue(config.icons.mode, ["auto", "nerd", "ascii"] as const),
		},
	};
}

function toggleEnabled(config: PiTuiConfig): PiTuiConfig {
	return { ...config, enabled: !config.enabled };
}

function toggleLanguage(config: PiTuiConfig): PiTuiConfig {
	return {
		...config,
		settingsLanguage: config.settingsLanguage === "en" ? "zh" : "en",
	};
}

function cycleCursorStyle(config: PiTuiConfig): PiTuiConfig {
	return {
		...config,
		cursorStyle: cycleValue(config.cursorStyle, [
			"block",
			"bar",
			"underline",
		] as const),
	};
}

function cycleWheelScrollLines(config: PiTuiConfig): PiTuiConfig {
	return {
		...config,
		fullscreen: {
			...config.fullscreen,
			wheelScrollLines:
				WHEEL_SCROLL_PRESETS.find((v) => v > config.fullscreen.wheelScrollLines) ??
				WHEEL_SCROLL_PRESETS[0],
		},
	};
}

function cycleSpeedLabel(config: PiTuiConfig): PiTuiConfig {
	return {
		...config,
		speed: {
			...config.speed,
			label: cycleValue(config.speed.label, SPEED_LABEL_PRESETS),
		},
	};
}

function cycleSpeedSlidingWindow(config: PiTuiConfig): PiTuiConfig {
	return {
		...config,
		speed: {
			...config.speed,
			slidingWindowMs: cycleValue(
				config.speed.slidingWindowMs,
				SLIDING_WINDOW_PRESETS,
			),
		},
	};
}

function cycleSpeedRenderInterval(config: PiTuiConfig): PiTuiConfig {
	return {
		...config,
		speed: {
			...config.speed,
			renderIntervalMs: cycleValue(
				config.speed.renderIntervalMs,
				RENDER_INTERVAL_PRESETS,
			),
		},
	};
}

function cycleSpeedMaxDisplay(config: PiTuiConfig): PiTuiConfig {
	return {
		...config,
		speed: {
			...config.speed,
			maxDisplayTokS: cycleValue(
				config.speed.maxDisplayTokS,
				MAX_DISPLAY_SPEED_PRESETS,
			),
		},
	};
}

function cycleSpeedCountStrategy(config: PiTuiConfig): PiTuiConfig {
	return {
		...config,
		speed: {
			...config.speed,
			countStrategy: cycleValue(
				config.speed.countStrategy,
				COUNT_STRATEGY_PRESETS,
			),
		},
	};
}

function toggleTelemetry(
	config: PiTuiConfig,
	key: keyof PiTuiConfig["telemetry"],
): PiTuiConfig {
	return {
		...config,
		telemetry: { ...config.telemetry, [key]: !config.telemetry[key] },
	};
}

function buildFeaturesItems(
	config: PiTuiConfig,
	copy: SettingsCopy,
): SettingItem[] {
	return [
		{
			id: "enabled",
			label: copy.labels.enabled,
			currentValue: config.enabled ? copy.values.on : copy.values.off,
		},
		{
			id: "settingsLanguage",
			label: copy.labels.language,
			currentValue: copy.values.languages[config.settingsLanguage],
		},
		{
			id: "wheelScrollLines",
			label: copy.labels.wheelScrollLines,
			currentValue: copy.values.wheelLines(config.fullscreen.wheelScrollLines),
		},
	];
}

function buildIconsItems(
	config: PiTuiConfig,
	copy: SettingsCopy,
): SettingItem[] {
	return [
		{
			id: "mode",
			label: copy.labels.iconMode,
			currentValue: copy.values.icons[config.icons.mode],
		},
		{
			id: "cursorStyle",
			label: copy.labels.cursorStyle,
			currentValue: copy.values.cursorStyles[config.cursorStyle],
		},
	];
}

function buildSegmentsItems(
	config: PiTuiConfig,
	copy: SettingsCopy,
): SettingItem[] {
	const segs = config.footerSegments;
	const flag = (value: boolean) => (value ? copy.values.on : copy.values.off);
	return [
		{ id: "cwd", label: copy.labels.cwd, currentValue: flag(segs.cwd) },
		{
			id: "sessionName",
			label: copy.labels.sessionName,
			currentValue: flag(segs.sessionName),
		},
		{
			id: "gitBranch",
			label: copy.labels.gitBranch,
			currentValue: flag(segs.gitBranch),
		},
		{
			id: "gitStatus",
			label: copy.labels.gitStatus,
			currentValue: flag(segs.gitStatus),
		},
		{
			id: "gitCommit",
			label: copy.labels.gitCommit,
			currentValue: flag(segs.gitCommit),
		},
		{
			id: "runtime",
			label: copy.labels.runtime,
			currentValue: flag(segs.runtime),
		},
		{
			id: "context",
			label: copy.labels.context,
			currentValue: flag(segs.context),
		},
		{ id: "tokens", label: copy.labels.tokens, currentValue: flag(segs.tokens) },
		{ id: "cost", label: copy.labels.cost, currentValue: flag(segs.cost) },
		{
			id: "speed",
			label: copy.labels.speedSegment,
			currentValue: flag(segs.speed),
		},
		{
			id: "cacheHit",
			label: copy.labels.cacheHit,
			currentValue: flag(segs.cacheHit),
		},
		{
			id: "extensionStatuses",
			label: copy.labels.extensionStatuses,
			currentValue: flag(segs.extensionStatuses),
		},
	];
}

function buildSpeedItems(
	config: PiTuiConfig,
	copy: SettingsCopy,
): SettingItem[] {
	const speed = config.speed;
	const flag = (value: boolean) => (value ? copy.values.on : copy.values.off);
	return [
		{
			id: "enabled",
			label: copy.labels.enabled,
			currentValue: flag(speed.enabled),
		},
		{
			id: "working",
			label: copy.labels.speedWorking,
			currentValue: flag(speed.working),
		},
		{ id: "label", label: copy.labels.speedLabel, currentValue: speed.label },
		{
			id: "slidingWindowMs",
			label: copy.labels.speedSlidingWindow,
			currentValue: copy.values.ms(speed.slidingWindowMs),
		},
		{
			id: "renderIntervalMs",
			label: copy.labels.speedRenderInterval,
			currentValue: copy.values.ms(speed.renderIntervalMs),
		},
		{
			id: "maxDisplayTokS",
			label: copy.labels.speedMaxDisplay,
			currentValue: copy.values.ms(speed.maxDisplayTokS),
		},
		{
			id: "useProviderTokens",
			label: copy.labels.speedProviderTokens,
			currentValue: flag(speed.useProviderTokens),
		},
		{
			id: "countStrategy",
			label: copy.labels.speedCountStrategy,
			currentValue: copy.values.countStrategies[speed.countStrategy],
		},
	];
}

function buildTelemetryItems(
	config: PiTuiConfig,
	copy: SettingsCopy,
): SettingItem[] {
	const telemetry = config.telemetry;
	const flag = (value: boolean) => (value ? copy.values.on : copy.values.off);
	return [
		{
			id: "enabled",
			label: copy.labels.enabled,
			currentValue: flag(telemetry.enabled),
		},
		{ id: "tps", label: "TPS", currentValue: flag(telemetry.tps) },
		{ id: "ttft", label: "TTFT", currentValue: flag(telemetry.ttft) },
		{
			id: "duration",
			label: copy.labels.totalDuration,
			currentValue: flag(telemetry.duration),
		},
		{
			id: "tokens",
			label: copy.labels.tokenCounts,
			currentValue: flag(telemetry.tokens),
		},
		{
			id: "stalls",
			label: copy.labels.stallDetails,
			currentValue: flag(telemetry.stalls),
		},
		{
			id: "cost",
			label: copy.labels.costRate,
			currentValue: flag(telemetry.cost),
		},
	];
}

function buildItems(tab: Tab, config: PiTuiConfig): SettingItem[] {
	const copy = COPY[config.settingsLanguage];
	switch (tab) {
		case "features":
			return buildFeaturesItems(config, copy);
		case "icons":
			return buildIconsItems(config, copy);
		case "segments":
			return buildSegmentsItems(config, copy);
		case "speed":
			return buildSpeedItems(config, copy);
		case "telemetry":
			return buildTelemetryItems(config, copy);
	}
}

function handleSettingChange(
	tab: Tab,
	itemId: string,
	config: PiTuiConfig,
): PiTuiConfig {
	if (tab === "features") {
		if (itemId === "enabled") return toggleEnabled(config);
		if (itemId === "settingsLanguage") return toggleLanguage(config);
		if (itemId === "wheelScrollLines") return cycleWheelScrollLines(config);
	}
	if (tab === "icons") {
		if (itemId === "mode") return cycleIconMode(config);
		if (itemId === "cursorStyle") return cycleCursorStyle(config);
	}
	if (tab === "segments") {
		return toggleSetting(config, itemId as keyof PiTuiConfig["footerSegments"]);
	}
	if (tab === "speed") {
		switch (itemId) {
			case "enabled":
				return toggleSpeedSetting(config, "enabled");
			case "working":
				return toggleSpeedSetting(config, "working");
			case "label":
				return cycleSpeedLabel(config);
			case "slidingWindowMs":
				return cycleSpeedSlidingWindow(config);
			case "renderIntervalMs":
				return cycleSpeedRenderInterval(config);
			case "maxDisplayTokS":
				return cycleSpeedMaxDisplay(config);
			case "useProviderTokens":
				return toggleSpeedSetting(config, "useProviderTokens");
			case "countStrategy":
				return cycleSpeedCountStrategy(config);
		}
	}
	if (tab === "telemetry") {
		return toggleTelemetry(config, itemId as keyof PiTuiConfig["telemetry"]);
	}
	return config;
}

interface SettingsUiHandle {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
}

class SettingsUi implements SettingsUiHandle {
	private tab: Tab = "features";
	private config: PiTuiConfig;
	private selectList: SelectList;
	private readonly selectedItemByTab: Partial<Record<Tab, string>> = {};
	private readonly container: Box;
	private readonly theme: Theme;
	private readonly onChange: (config: PiTuiConfig) => void;
	private readonly onClose: () => void;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private compact = false;

	constructor(
		theme: Theme,
		config: PiTuiConfig,
		onChange: (config: PiTuiConfig) => void,
		onClose: () => void,
	) {
		this.theme = theme;
		this.config = config;
		this.onChange = onChange;
		this.onClose = onClose;
		this.container = new Box(1, 1, (s: string) => theme.bg("customMessageBg", s));
		this.selectList = new SelectList([], 12, {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});
		this.rebuild();
	}

	private applySetting(itemId: string): void {
		this.selectedItemByTab[this.tab] = itemId;
		this.config = handleSettingChange(this.tab, itemId, this.config);
		this.onChange(this.config);
		this.rebuild(itemId);
	}

	private switchTab(offset: number): void {
		const idx = TABS.indexOf(this.tab);
		this.tab = TABS[(idx + offset + TABS.length) % TABS.length]!;
		this.rebuild();
	}

	private rebuild(preferredItemId = this.selectedItemByTab[this.tab]): void {
		const copy = COPY[this.config.settingsLanguage];
		this.container.clear();
		this.container.addChild(
			new Text(this.theme.bold(this.theme.fg("accent", copy.title)), 1, 0),
		);

		const tabBar = TABS.map((tab) => {
			const active = tab === this.tab;
			const label = active ? `[${copy.tabs[tab]}]` : ` ${copy.tabs[tab]} `;
			return active ? this.theme.fg("accent", label) : this.theme.fg("dim", label);
		}).join(" ");
		this.container.addChild(new Text(tabBar, 1, 0));
		this.container.addChild(new Text(this.theme.fg("dim", copy.hint), 1, 0));

		const items = buildItems(this.tab, this.config).map(
			(item) =>
				({
					value: item.id,
					label: this.compact ? `${item.label}: ${item.currentValue}` : item.label,
					description: this.compact ? undefined : item.currentValue,
				}) as SelectItem,
		);
		this.selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (t) => this.theme.fg("accent", t),
			selectedText: (t) => this.theme.fg("accent", t),
			description: (t) => this.theme.fg("muted", t),
			scrollInfo: (t) => this.theme.fg("dim", t),
			noMatch: (t) => this.theme.fg("warning", t),
		});
		const selectedIndex = items.findIndex(
			(item) => item.value === preferredItemId,
		);
		if (selectedIndex >= 0) {
			this.selectList.setSelectedIndex(selectedIndex);
		}
		this.selectedItemByTab[this.tab] = this.selectList.getSelectedItem()?.value;
		this.selectList.onSelectionChange = (item) => {
			this.selectedItemByTab[this.tab] = item.value;
		};
		this.selectList.onSelect = (item) => {
			this.applySetting(item.value);
		};
		this.selectList.onCancel = () => {
			this.onClose();
		};
		this.container.addChild(this.selectList);

		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.switchTab(1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.switchTab(-1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.space) || data === " ") {
			const selected = this.selectList.getSelectedItem();
			if (selected) this.applySetting(selected.value);
		} else {
			this.selectList.handleInput?.(data);
		}
		this.invalidate();
	}

	render(width: number): string[] {
		const compact = width <= 60;
		if (compact !== this.compact) {
			this.compact = compact;
			this.rebuild();
		}
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = this.container.render(width);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.container.invalidate();
	}
}

export function registerSettingsCommand(pi: ExtensionAPI): void {
	// Non-interactive config writes from other modules should still refresh the footer.
	subscribeConfig(() => requestFooterRender());

	pi.registerCommand("pi-tui", {
		description: "Open the Pi TUI settings UI",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
			await ctx.ui.custom<void>(
				(tui: TUI, theme, _kb, done) => {
					const ui = new SettingsUi(
						theme,
						getConfig(),
						(next) => {
							const prev = getConfig();
							updateConfig(next);
							const controls = getEditorControls();
							if (next.cursorStyle !== prev.cursorStyle) {
								controls?.setCursorStyle(next.cursorStyle);
							}
							if (
								next.fullscreen.wheelScrollLines !== prev.fullscreen.wheelScrollLines
							) {
								controls?.setWheelScrollLines(next.fullscreen.wheelScrollLines);
							}
						},
						() => done(undefined),
					);
					return {
						render: (w: number) => ui.render(w),
						invalidate: () => ui.invalidate(),
						handleInput: (data: string) => {
							ui.handleInput(data);
							tui.requestRender();
						},
					};
				},
				{ overlay: true },
			);
			// Overlay closed and focus back on the editor. Refresh the footer so
			// newly toggled segments (notably footer speed) render immediately.
			requestFooterRender();
		},
	});
}

export default function piSettings(pi: ExtensionAPI): void {
	const config = getConfig();
	if (!config.enabled || !config.modules.settings) return;
	registerSettingsCommand(pi);
}
