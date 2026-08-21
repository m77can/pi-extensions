import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	wrapTextWithAnsi,
	type TUI,
} from "@earendil-works/pi-tui";
import type { PiTuiConfig, SettingsLanguage } from "../../shared/config.js";
import {
	getConfig,
	updateConfig,
	subscribeConfig,
	requestFooterRender,
	getEditorControls,
} from "../../shared/pi-tui-store.js";
import {
	alignRight,
	padRight,
	truncateToWidth,
	visibleWidth,
} from "../../shared/utils.js";

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
	/** Which config block this item mutates. Only needed on the merged Metrics tab
	 * (speed/telemetry share it); other tabs infer from their own handler. */
	kind?: "speed" | "telemetry";
	/** Section header row (non-selectable divider) for the merged Metrics tab. */
	header?: boolean;
	/** Explanation shown under the selected item, so each toggle reads clearly. */
	description?: string;
}

type Tab = "features" | "icons" | "segments" | "metrics";

const TABS: Tab[] = ["features", "icons", "segments", "metrics"];

const COPY = {
	en: {
		title: "Pi TUI Settings",
		tabs: {
			features: "General",
			icons: "Appearance",
			segments: "Footer",
			metrics: "Metrics",
		},
		hint:
			"Tab/Shift+Tab/←/→: tabs · ↑/↓: move · Enter/Space: change · Esc/q: close",
		labels: {
			enabled: "Enabled",
			language: "Language",
			wheelScrollLines: "Mouse wheel speed",
			cursorStyle: "Cursor style",
			iconMode: "Icon mode",
			theme: "Theme",
			cwd: "CWD",
			sessionName: "Session name",
			gitBranch: "Git branch",
			gitStatus: "Git status",
			gitCommit: "Git commit (detached)",
			runtime: "Runtime",
			context: "Context bar",
			tokens: "Tokens",
			extensionStatuses: "Extension status line",
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
			routerSpec: "Router spec (recon mode)",
			chrome: "Rounded system panels",
			speedEnabled: "Live speed enabled",
			speedGroup: "Live speed",
			telemetryGroup: "Per-turn telemetry",
		},
		descriptions: {
			enabled: "Master switch for the whole pi-tui UI",
			speedWorking: "Live tok/s in the status line while streaming",
			speedLabel: "Unit suffix shown after the speed number",
			speedSlidingWindow:
				"Live speed is averaged over this recent window (larger = smoother)",
			speedRenderInterval: "How often the live speed refreshes on screen",
			speedMaxDisplay: "Speeds above this are treated as artifacts and hidden",
			speedProviderTokens:
				"Prefer the model's reported token count over local estimation",
			speedCountStrategy:
				"Estimate = word-ish split · Direct = 1 per delta · Chars÷4 = text length ÷ 4",
			tps: "Decode throughput = output tokens ÷ (decode time − stalls)",
			ttft: "Time to first token from request start",
			totalDuration: "Total wall time of the turn",
			tokenCounts: "Input / output tokens for the turn",
			stallDetails: "Time lost to stalls ≥ 500ms (inference pauses)",
			settingsLanguage: "Interface language for the settings panel",
			wheelScrollLines: "Lines scrolled per mouse-wheel notch in fullscreen",
			iconMode: "Nerd Font icons vs ASCII glyphs (auto-detects terminal)",
			cursorStyle: "Shape of the text cursor in the editor",
			theme: "Ui theme: pi-accent / pi-purple / pi-default",
			cwd: "Working directory shown on the footer left",
			sessionName: "Session name next to the CWD",
			gitBranch: "Current branch name (or detached HEAD)",
			gitStatus: "Modified/staged/untracked/conflict counts",
			gitCommit: "Short hash + tag when in detached HEAD",
			runtime: "Detected language runtime (node/rust/go/...)",
			context: "Context occupancy bar and percentage",
			tokens: "Input / output token counts",
			cacheHit: "DeepSeek cache-hit share (cacheRead ÷ billed input)",
			extensionStatuses: "Status line from other loaded extensions",
			routerSpec: "First-round read+bash recon before full continuation",
			chrome:
				"Round the kernel panels (changelog/reload/settings) with ╭─ corners",
		},
		values: {
			on: "On",
			off: "Off",
			languages: { en: "English", zh: "简体中文" },
			wheelLines: (count: number) =>
				`${count} ${count === 1 ? "line" : "lines"} / notch`,
			cursorStyles: { block: "Block", bar: "Bar", underline: "Underline" },
			icons: { auto: "Auto", nerd: "Nerd", ascii: "ASCII" },
			theme: { "pi-accent": "Accent", "pi-purple": "Purple", dark: "Default" },
			ms: (count: number) => `${count}ms`,
			countStrategies: {
				estimate: "Estimate",
				direct: "Direct",
				chars: "Chars÷4",
			},
		},
	},
	zh: {
		title: "Pi TUI 设置",
		tabs: {
			features: "常规",
			icons: "外观",
			segments: "Footer",
			metrics: "指标",
		},
		hint: "Tab/Shift+Tab/←/→：切页 · ↑/↓：移动 · Enter/Space：更改 · Esc/q：关闭",
		labels: {
			enabled: "启用",
			language: "语言",
			wheelScrollLines: "鼠标滚轮速度",
			cursorStyle: "光标样式",
			iconMode: "图标模式",
			theme: "主题",
			cwd: "当前目录",
			sessionName: "会话名",
			gitBranch: "Git 分支",
			gitStatus: "Git 状态",
			gitCommit: "Git 提交（分离 HEAD）",
			runtime: "运行环境",
			context: "上下文栏",
			tokens: "Token",
			extensionStatuses: "扩展状态行",
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
			routerSpec: "Router spec（侦察模式）",
			chrome: "系统面板圆角",
			speedEnabled: "实时速度启用",
			speedGroup: "实时速度",
			telemetryGroup: "每轮遥测",
		},
		descriptions: {
			enabled: "整个 pi-tui 界面的总开关",
			speedWorking: "流式过程中状态栏里显示的实时速度",
			speedLabel: "速度数字后面显示的单位后缀",
			speedSlidingWindow: "实时速度按最近这个窗口平均（越大越平滑）",
			speedRenderInterval: "实时速度在屏幕上刷新的频率",
			speedMaxDisplay: "超过这个速度视为异常并隐藏",
			speedProviderTokens: "优先用模型上报的 token 数，而不是本地估算",
			speedCountStrategy: "估算=词切分 · 直接=每个增量算 1 · 字符÷4=文本长度÷4",
			tps: "解码吞吐 = 输出 token ÷（解码时间 − 停顿）",
			ttft: "从请求开始到首个 token 的时间",
			totalDuration: "本轮的总耗时",
			tokenCounts: "本轮的输入 / 输出 token 数",
			stallDetails: "≥500ms 的停顿（推理暂停）占用的时间",
			settingsLanguage: "设置面板的界面语言",
			wheelScrollLines: "全屏模式下每次滚动滚轮的行数",
			iconMode: "Nerd Font 图标 vs ASCII 符号（自动检测终端）",
			cursorStyle: "编辑器里文本光标的形状",
			theme: "UI 主题：pi-accent / pi-purple / pi-default",
			cwd: "Footer 左侧显示的工作目录",
			sessionName: "当前目录旁边的会话名",
			gitBranch: "当前分支名（或分离 HEAD）",
			gitStatus: "已修改/已暂存/未跟踪/冲突计数",
			gitCommit: "分离 HEAD 时的短哈希 + 标签",
			runtime: "检测到的语言运行时（node/rust/go/...）",
			context: "上下文占用进度条和百分比",
			tokens: "输入 / 输出 token 数",
			cacheHit: "DeepSeek 缓存命中率（cacheRead ÷ 计费输入）",
			extensionStatuses: "其他已加载扩展的状态行",
			routerSpec: "首轮 read+bash 侦察，再全量续跑",
			chrome: "用 ╭─ 圆角替换内核面板（changelog/reload/设置）的横线",
		},
		values: {
			on: "开启",
			off: "关闭",
			languages: { en: "English", zh: "简体中文" },
			wheelLines: (count: number) => `每格 ${count} 行`,
			cursorStyles: { block: "块", bar: "竖线", underline: "下划线" },
			icons: { auto: "自动", nerd: "Nerd", ascii: "ASCII" },
			theme: { "pi-accent": "强调色", "pi-purple": "紫色", dark: "默认" },
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

function toggleRouterSpec(config: PiTuiConfig): PiTuiConfig {
	return {
		...config,
		modules: { ...config.modules, routerSpec: !config.modules.routerSpec },
	};
}

function toggleChrome(config: PiTuiConfig): PiTuiConfig {
	return { ...config, chrome: !config.chrome };
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
	const d = copy.descriptions;
	return [
		{
			id: "enabled",
			label: copy.labels.enabled,
			currentValue: config.enabled ? copy.values.on : copy.values.off,
			description: d.enabled,
		},
		{
			id: "settingsLanguage",
			label: copy.labels.language,
			currentValue: copy.values.languages[config.settingsLanguage],
			description: d.settingsLanguage,
		},
		{
			id: "wheelScrollLines",
			label: copy.labels.wheelScrollLines,
			currentValue: copy.values.wheelLines(config.fullscreen.wheelScrollLines),
			description: d.wheelScrollLines,
		},
		{
			id: "routerSpec",
			label: copy.labels.routerSpec,
			currentValue: config.modules.routerSpec ? copy.values.on : copy.values.off,
			description: d.routerSpec,
		},
		{
			id: "chrome",
			label: copy.labels.chrome,
			currentValue: config.chrome ? copy.values.on : copy.values.off,
			description: d.chrome,
		},
	];
}

function buildIconsItems(
	config: PiTuiConfig,
	copy: SettingsCopy,
): SettingItem[] {
	const d = copy.descriptions;
	return [
		{
			id: "mode",
			label: copy.labels.iconMode,
			currentValue: copy.values.icons[config.icons.mode],
			description: d.iconMode,
		},
		{
			id: "cursorStyle",
			label: copy.labels.cursorStyle,
			currentValue: copy.values.cursorStyles[config.cursorStyle],
			description: d.cursorStyle,
		},
		{
			id: "theme",
			label: copy.labels.theme,
			currentValue: "", // filled in SettingsUi from the active theme name
			description: d.theme,
		},
	];
}

function buildSegmentsItems(
	config: PiTuiConfig,
	copy: SettingsCopy,
): SettingItem[] {
	const segs = config.footerSegments;
	const flag = (value: boolean) => (value ? copy.values.on : copy.values.off);
	const d = copy.descriptions;
	return [
		{
			id: "cwd",
			label: copy.labels.cwd,
			currentValue: flag(segs.cwd),
			description: d.cwd,
		},
		{
			id: "sessionName",
			label: copy.labels.sessionName,
			currentValue: flag(segs.sessionName),
			description: d.sessionName,
		},
		{
			id: "gitBranch",
			label: copy.labels.gitBranch,
			currentValue: flag(segs.gitBranch),
			description: d.gitBranch,
		},
		{
			id: "gitStatus",
			label: copy.labels.gitStatus,
			currentValue: flag(segs.gitStatus),
			description: d.gitStatus,
		},
		{
			id: "gitCommit",
			label: copy.labels.gitCommit,
			currentValue: flag(segs.gitCommit),
			description: d.gitCommit,
		},
		{
			id: "runtime",
			label: copy.labels.runtime,
			currentValue: flag(segs.runtime),
			description: d.runtime,
		},
		{
			id: "context",
			label: copy.labels.context,
			currentValue: flag(segs.context),
			description: d.context,
		},
		{
			id: "tokens",
			label: copy.labels.tokens,
			currentValue: flag(segs.tokens),
			description: d.tokens,
		},
		{
			id: "cacheHit",
			label: copy.labels.cacheHit,
			currentValue: flag(segs.cacheHit),
			description: d.cacheHit,
		},
		{
			id: "extensionStatuses",
			label: copy.labels.extensionStatuses,
			currentValue: flag(segs.extensionStatuses),
			description: d.extensionStatuses,
		},
	];
}

function buildSpeedItems(
	config: PiTuiConfig,
	copy: SettingsCopy,
): SettingItem[] {
	const speed = config.speed;
	const flag = (value: boolean) => (value ? copy.values.on : copy.values.off);
	const d = copy.descriptions;
	return [
		{
			id: "enabled",
			label: copy.labels.speedEnabled,
			currentValue: flag(speed.enabled),
			description: d.enabled,
			kind: "speed",
		},
		{
			id: "working",
			label: copy.labels.speedWorking,
			currentValue: flag(speed.working),
			description: d.speedWorking,
			kind: "speed",
		},
		{
			id: "label",
			label: copy.labels.speedLabel,
			currentValue: speed.label,
			description: d.speedLabel,
			kind: "speed",
		},
		{
			id: "slidingWindowMs",
			label: copy.labels.speedSlidingWindow,
			currentValue: copy.values.ms(speed.slidingWindowMs),
			description: d.speedSlidingWindow,
			kind: "speed",
		},
		{
			id: "renderIntervalMs",
			label: copy.labels.speedRenderInterval,
			currentValue: copy.values.ms(speed.renderIntervalMs),
			description: d.speedRenderInterval,
			kind: "speed",
		},
		{
			id: "maxDisplayTokS",
			label: copy.labels.speedMaxDisplay,
			currentValue: copy.values.ms(speed.maxDisplayTokS),
			description: d.speedMaxDisplay,
			kind: "speed",
		},
		{
			id: "useProviderTokens",
			label: copy.labels.speedProviderTokens,
			currentValue: flag(speed.useProviderTokens),
			description: d.speedProviderTokens,
			kind: "speed",
		},
		{
			id: "countStrategy",
			label: copy.labels.speedCountStrategy,
			currentValue: copy.values.countStrategies[speed.countStrategy],
			description: d.speedCountStrategy,
			kind: "speed",
		},
	];
}

function buildTelemetryItems(
	config: PiTuiConfig,
	copy: SettingsCopy,
): SettingItem[] {
	const telemetry = config.telemetry;
	const flag = (value: boolean) => (value ? copy.values.on : copy.values.off);
	const d = copy.descriptions;
	return [
		{
			id: "enabled",
			label: copy.labels.enabled,
			currentValue: flag(telemetry.enabled),
			description: d.enabled,
			kind: "telemetry",
		},
		{
			id: "tps",
			label: "TPS",
			currentValue: flag(telemetry.tps),
			description: d.tps,
			kind: "telemetry",
		},
		{
			id: "ttft",
			label: "TTFT",
			currentValue: flag(telemetry.ttft),
			description: d.ttft,
			kind: "telemetry",
		},
		{
			id: "duration",
			label: copy.labels.totalDuration,
			currentValue: flag(telemetry.duration),
			description: d.totalDuration,
			kind: "telemetry",
		},
		{
			id: "tokens",
			label: copy.labels.tokenCounts,
			currentValue: flag(telemetry.tokens),
			description: d.tokenCounts,
			kind: "telemetry",
		},
		{
			id: "stalls",
			label: copy.labels.stallDetails,
			currentValue: flag(telemetry.stalls),
			description: d.stallDetails,
			kind: "telemetry",
		},
	];
}

/** Merged Metrics tab: live-speed tuning first, then per-turn telemetry,
 * separated by non-selectable header rows. */
function buildMetricsItems(
	config: PiTuiConfig,
	copy: SettingsCopy,
): SettingItem[] {
	return [
		{
			id: "h-speed",
			label: copy.labels.speedGroup,
			currentValue: "",
			header: true,
		},
		...buildSpeedItems(config, copy),
		{
			id: "h-telemetry",
			label: copy.labels.telemetryGroup,
			currentValue: "",
			header: true,
		},
		...buildTelemetryItems(config, copy),
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
		case "metrics":
			return buildMetricsItems(config, copy);
	}
}

function handleSettingChange(
	tab: Tab,
	item: SettingItem,
	config: PiTuiConfig,
): PiTuiConfig {
	const itemId = item.id;
	if (tab === "features") {
		if (itemId === "enabled") return toggleEnabled(config);
		if (itemId === "settingsLanguage") return toggleLanguage(config);
		if (itemId === "wheelScrollLines") return cycleWheelScrollLines(config);
		if (itemId === "routerSpec") return toggleRouterSpec(config);
		if (itemId === "chrome") return toggleChrome(config);
	}
	if (tab === "icons") {
		if (itemId === "mode") return cycleIconMode(config);
		if (itemId === "cursorStyle") return cycleCursorStyle(config);
		if (itemId === "theme") {
			// Theme switching persists in pi's settings.json (ctx.ui.setTheme),
			// not in pi-tui config; keep config unchanged here.
			return config;
		}
	}
	if (tab === "segments") {
		return toggleSetting(config, itemId as keyof PiTuiConfig["footerSegments"]);
	}
	if (tab === "metrics") {
		// Merged tab: dispatch by the item's kind (speed vs telemetry).
		if (item.kind === "speed") {
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
		if (item.kind === "telemetry") {
			return toggleTelemetry(config, itemId as keyof PiTuiConfig["telemetry"]);
		}
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
	private themeName: string;
	private selectedIndex = 0;
	private readonly selectedItemByTab: Partial<Record<Tab, string>> = {};
	private readonly theme: Theme;
	private readonly onChange: (config: PiTuiConfig) => void;
	private readonly onClose: () => void;
	/** External effect not representable in PiTuiConfig (e.g. pi theme switch).
	 * Returns the new display value for the mutated item. */
	private readonly onExternalAction: (itemId: string) => string;
	/** Border/decoration color, keyed to the current thinking level so the
	 * settings frame matches the input editor's border exactly. */
	private readonly getBorder: () => (str: string) => string;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private compact = false;

	constructor(
		theme: Theme,
		config: PiTuiConfig,
		themeName: string,
		onChange: (config: PiTuiConfig) => void,
		onClose: () => void,
		getBorder: () => (str: string) => string,
		onExternalAction: (itemId: string) => string,
	) {
		this.theme = theme;
		this.config = config;
		this.themeName = themeName;
		this.onChange = onChange;
		this.onClose = onClose;
		this.getBorder = getBorder;
		this.onExternalAction = onExternalAction;
		this.restoreSelection();
	}

	private items(): SettingItem[] {
		return buildItems(this.tab, this.config).map((item) =>
			item.id === "theme" ? { ...item, currentValue: this.themeName } : item,
		);
	}

	private isSelectable(item: SettingItem | undefined): boolean {
		return !!item && !item.header;
	}

	private restoreSelection(): void {
		const preferred = this.selectedItemByTab[this.tab];
		const idx = preferred ? this.items().findIndex((i) => i.id === preferred) : 0;
		this.selectedIndex = idx >= 0 ? idx : 0;
		// Never land on a header row.
		if (
			this.selectedIndex < this.items().length - 1 &&
			!this.isSelectable(this.items()[this.selectedIndex])
		) {
			this.selectedIndex += 1;
		}
	}

	private applySetting(item: SettingItem): void {
		this.selectedItemByTab[this.tab] = item.id;
		if (item.id === "theme" && this.tab === "icons") {
			// External mutation returns the new display value; refresh so the
			// item label tracks the switched theme.
			this.themeName = this.onExternalAction(item.id);
			this.invalidate();
			return;
		}
		this.config = handleSettingChange(this.tab, item, this.config);
		this.onChange(this.config);
		this.invalidate();
	}

	private switchTab(offset: number): void {
		const idx = TABS.indexOf(this.tab);
		this.tab = TABS[(idx + offset + TABS.length) % TABS.length]!;
		this.restoreSelection();
		this.invalidate();
	}

	private move(offset: number): void {
		const all = this.items();
		const n = all.length;
		if (n === 0) return;
		let next = this.selectedIndex;
		for (let i = 0; i < n; i++) {
			next = (next + offset + n) % n;
			if (this.isSelectable(all[next])) break;
		}
		if (!this.isSelectable(all[next])) return;
		this.selectedIndex = next;
		this.selectedItemByTab[this.tab] = all[this.selectedIndex]?.id;
		this.invalidate();
	}

	private borderLine(
		left: string,
		label: string,
		right: string,
		width: number,
	): string {
		const paint = this.getBorder();
		if (width <= 1) return "";
		if (label.length === 0 || width < 8) {
			return paint(
				truncateToWidth(
					left + "─".repeat(Math.max(0, width - 2)) + right,
					width,
					"",
				),
			);
		}
		const fill = Math.max(0, width - 2 - visibleWidth(label) - 2);
		return `${paint(left)}${paint(" ")}${label}${paint(" ")}${paint("─".repeat(fill))}${paint(right)}`;
	}

	private boxLine(content: string, width: number): string {
		const paint = this.getBorder();
		if (width <= 2) return truncateToWidth(content, width, "");
		return `${paint("│")}${padRight(content, width - 2)}${paint("│")}`;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.switchTab(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.switchTab(-1);
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (
			matchesKey(data, Key.enter) ||
			matchesKey(data, Key.space) ||
			data === " "
		) {
			const item = this.items()[this.selectedIndex];
			if (item && this.isSelectable(item)) this.applySetting(item);
			return;
		}
		this.invalidate();
	}

	render(width: number): string[] {
		const compact = width <= 60;
		if (compact !== this.compact) {
			this.compact = compact;
			this.invalidate();
		}
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const theme = this.theme;
		const copy = COPY[this.config.settingsLanguage];
		const paint = (s: string) => theme.fg("accent", s);
		const dim = (s: string) => theme.fg("dim", s);
		const muted = (s: string) => theme.fg("muted", s);
		const bold = (s: string) => theme.bold(s);

		if (width < 12) return [paint(`pi-tui`)];

		const innerWidth = Math.max(0, width - 2);
		const items = this.items();
		const maxVisible = Math.max(3, Math.min(items.length, 12));

		// Clamp selectedIndex into range and compute scroll window.
		if (this.selectedIndex >= items.length) this.selectedIndex = items.length - 1;
		if (this.selectedIndex < 0) this.selectedIndex = 0;
		let start = 0;
		if (this.selectedIndex >= maxVisible) {
			start = this.selectedIndex - maxVisible + 1;
		}
		const visibleItems = items.slice(start, start + maxVisible);

		const lines: string[] = [];

		// Top border carries the title (matches pi-header's border style).
		lines.push(
			this.borderLine(
				"╭",
				` ${paint(bold("pi-tui"))} ${muted(copy.title)} `,
				"╮",
				width,
			),
		);

		// Tab bar (active tab accent-bracketed, others dim).
		const tabBar = TABS.map((t) => {
			const label = copy.tabs[t];
			return t === this.tab ? paint(bold(`[${label}]`)) : dim(` ${label} `);
		}).join(" ");
		lines.push(this.boxLine(truncateToWidth(tabBar, innerWidth), width));

		// Separator.
		lines.push(this.boxLine(dim("─".repeat(Math.max(0, innerWidth))), width));

		// Items: selected row accent-bracketed, value right-aligned (footer style).
		// Header rows render as dim separators and are never selectable.
		for (const item of visibleItems) {
			if (item.header) {
				const label = bold(paint(`─ ${item.label} ─`));
				lines.push(this.boxLine(truncateToWidth(label, innerWidth), width));
				continue;
			}
			const isSel = item.id === items[this.selectedIndex]?.id;
			const prefix = isSel ? paint("▸ ") : "  ";
			const label = isSel ? paint(bold(item.label)) : item.label;
			if (this.compact) {
				lines.push(
					this.boxLine(
						truncateToWidth(`${prefix}${label}: ${item.currentValue}`, innerWidth),
						width,
					),
				);
			} else {
				const lineInner = alignRight(
					`${prefix}${label}`,
					muted(item.currentValue),
					innerWidth,
					theme,
				);
				lines.push(this.boxLine(lineInner, width));
			}
		}

		// Description panel for the selected item (dim, word-wrapped).
		const selectedItem = items[this.selectedIndex];
		if (selectedItem?.description) {
			lines.push(this.boxLine(dim(" ".repeat(Math.max(0, innerWidth))), width));
			const descWrapped = wrapTextWithAnsi(
				dim(`ℹ ${selectedItem.description}`),
				innerWidth,
			);
			for (const dl of descWrapped) {
				lines.push(this.boxLine(padRight(dl, innerWidth), width));
			}
		}

		// Scroll info when the tab has more items than fit.
		if (items.length > maxVisible) {
			const scroll = dim(
				`${start + 1}-${start + visibleItems.length} / ${items.length}`,
			);
			lines.push(this.boxLine(alignRight("", scroll, innerWidth, theme), width));
		}

		// Hint line (dim), then bottom border.
		lines.push(this.boxLine(dim(truncateToWidth(copy.hint, innerWidth)), width));
		lines.push(this.borderLine("╰", "", "╯", width));

		this.cachedWidth = width;
		this.cachedLines = lines.map((l) => truncateToWidth(l, width, ""));
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export function registerSettingsCommand(pi: ExtensionAPI): void {
	// Non-interactive config writes from other modules should still refresh the footer.
	subscribeConfig(() => requestFooterRender());

	const openPanel = async (ctx: ExtensionContext): Promise<boolean> => {
		if (!ctx.hasUI) return false;
		await ctx.ui.custom<void>(
			(tui: TUI, theme, _kb, done) => {
				const ui = new SettingsUi(
					theme,
					getConfig(),
					(theme as { name?: string }).name ?? "dark",
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
					() => (s: string) => theme.fg("accent", s),
					(itemId) => {
						if (itemId !== "theme") return "";
						const presets = ["pi-accent", "pi-purple", "dark"] as const;
						const currentName = (ctx.ui.theme as { name?: string }).name ?? "dark";
						const idx = presets.indexOf(currentName as (typeof presets)[number]);
						const nextName = presets[(idx + 1) % presets.length] ?? presets[0];
						ctx.ui.setTheme(nextName);
						return nextName;
					},
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
		return true;
	};

	pi.registerCommand("pi-tui", {
		description: "Open the Pi TUI settings UI",
		handler: async (_args, ctx: ExtensionContext) => {
			await openPanel(ctx);
		},
	});
}

export default function piSettings(pi: ExtensionAPI): void {
	const config = getConfig();
	if (!config.enabled || !config.modules.settings) return;
	registerSettingsCommand(pi);
}
