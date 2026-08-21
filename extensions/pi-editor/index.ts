import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
	CURSOR_MARKER,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { CursorStyle } from "../../shared/config.js";
import {
	applyFullscreenWheelScrollLines,
	DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
} from "../../shared/fullscreen-scroll.js";
import {
	findBottomBorderIndex,
	isEditorBorderLine,
	stripAnsi,
} from "../../shared/utils.js";
import {
	getConfig,
	setEditorControls,
	subscribeConfig,
} from "../../shared/pi-tui-store.js";

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const m = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (m === undefined || m === "tui");
	} catch {
		return false;
	}
}

function fillLine(content: string, width: number): string {
	const truncated = truncateToWidth(content, Math.max(0, width), "");
	const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return `${truncated}${pad}`;
}

const CURSOR_STYLE_SEQUENCES: Partial<Record<CursorStyle, string>> = {
	bar: "\x1b[6 q",
	underline: "\x1b[4 q",
};
const DEFAULT_CURSOR_STYLE_SEQUENCE = "\x1b[0 q";

function removeSoftwareCursor(line: string, cursorMarker = ""): string {
	return line.replace(
		/\x1b\[7m([\s\S]*?)\x1b\[0m/g,
		(_match, cursor: string) => {
			const replacement = `${cursorMarker}${cursor}`;
			cursorMarker = "";
			return replacement;
		},
	);
}

function configureCursor(tui: TUI, cursorStyle: CursorStyle): void {
	if (cursorStyle === "block") return;
	tui.setShowHardwareCursor(true);
	const sequence = CURSOR_STYLE_SEQUENCES[cursorStyle];
	if (sequence) tui.terminal.write(sequence);
}

function roundedBorder(
	width: number,
	kind: "top" | "bottom",
	paint: (s: string) => string,
	sourceLine?: string,
): string {
	if (width < 2)
		return paint(truncateToWidth(kind === "top" ? "╭╮" : "╰╯", width, ""));
	const corners = kind === "top" ? (["╭", "╮"] as const) : (["╰", "╯"] as const);

	if (sourceLine) {
		const plain = stripAnsi(sourceLine);
		const scrollMatch = plain.match(/([↑↓]\s+\d+\s+more)/);
		if (scrollMatch) {
			const label = `─── ${scrollMatch[1]} `;
			const fill = Math.max(0, width - 2 - visibleWidth(label));
			return paint(`${corners[0]}${label}${"─".repeat(fill)}${corners[1]}`);
		}
	}

	return paint(
		`${corners[0]}${"─".repeat(Math.max(0, width - 2))}${corners[1]}`,
	);
}

export class PiEditor extends CustomEditor {
	private readonly getRail: () => string;
	private readonly getBorder: (s: string) => string;
	private cursorStyle: CursorStyle;
	private previewHardwareCursor = false;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		cursorStyle: CursorStyle = "block",
		paint?: (s: string) => string,
	) {
		super(tui, editorTheme, keybindings, { paddingX: 0 });
		this.cursorStyle = cursorStyle;
		configureCursor(tui, cursorStyle);
		// The rounded frame uses a FIXED injected paint, NOT the mutable
		// `this.borderColor`. Pi's framework recolors `borderColor` on thinking-
		// level / bash-mode changes (updateEditorBorderColor), which would leak
		// the thinking color into the frame. A fixed paint keeps the input frame
		// identical to the header/footer accent color regardless of that.
		const frame = paint ?? ((s: string) => editorTheme.borderColor(s));
		this.getRail = () => frame("│");
		this.getBorder = frame;
	}

	override setPaddingX(_padding: number): void {
		// The custom rail owns the horizontal inset and keeps one stable text gap.
		super.setPaddingX(0);
	}

	setCursorStyle(cursorStyle: CursorStyle, blockHardwareCursor = false): void {
		const styleChanged = cursorStyle !== this.cursorStyle;
		this.previewHardwareCursor = cursorStyle !== "block";
		this.cursorStyle = cursorStyle;
		if (styleChanged) {
			if (cursorStyle === "block") {
				this.tui.terminal.write(DEFAULT_CURSOR_STYLE_SEQUENCE);
				this.tui.setShowHardwareCursor(blockHardwareCursor);
			} else {
				configureCursor(this.tui, cursorStyle);
			}
		}
		this.tui.requestRender();
	}

	private renderBase(width: number): string[] {
		const renderedLines = super.render(width);
		if (this.cursorStyle === "block") return renderedLines;

		// A focused overlay suppresses the editor's cursor marker. Preserve its
		// position only for the live settings preview, then clear it on refocus.
		let cursorMarker =
			this.previewHardwareCursor && !this.focused ? CURSOR_MARKER : "";
		if (this.focused) this.previewHardwareCursor = false;
		return renderedLines.map((line) => {
			const rendered = removeSoftwareCursor(line, cursorMarker);
			if (rendered !== line) cursorMarker = "";
			return rendered;
		});
	}

	render(width: number): string[] {
		if (width < 4) return this.renderBase(width);

		const rail = this.getRail();
		const borderPaint = this.getBorder;
		// 1-char rail + 1-char gap on each side = 4 chars of chrome.
		const innerWidth = Math.max(0, width - 4);
		const baseLines = this.renderBase(innerWidth);
		const bottomIdx = findBottomBorderIndex(baseLines);

		const result: string[] = [];
		result.push(roundedBorder(width, "top", borderPaint, baseLines[0]));

		for (let i = 1; i < bottomIdx; i++) {
			const line = baseLines[i] ?? "";
			if (isEditorBorderLine(line)) {
				result.push(`${rail} ${fillLine("", innerWidth)} ${rail}`);
			} else {
				result.push(`${rail} ${fillLine(line, innerWidth)} ${rail}`);
			}
		}

		result.push(
			roundedBorder(width, "bottom", borderPaint, baseLines[bottomIdx]),
		);

		for (let i = bottomIdx + 1; i < baseLines.length; i++) {
			result.push(baseLines[i]!);
		}

		return result.map((line) => truncateToWidth(line, width, ""));
	}
}

export function installEditor(
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
	cursorStyle: CursorStyle = "block",
	wheelScrollLines = DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
) {
	let activeTui: TUI | undefined;
	let activeEditor: PiEditor | undefined;
	let previousHardwareCursor: boolean | undefined;
	let currentCursorStyle = cursorStyle;
	let currentWheelScrollLines = wheelScrollLines;

	ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
		activeTui = tui;
		applyFullscreenWheelScrollLines(tui, currentWheelScrollLines);
		previousHardwareCursor = tui.getShowHardwareCursor();
		// Fixed accent paint: input frame matches header/footer accent and is
		// immune to the framework's thinking-level border recoloring.
		const paint = (s: string) => ctx.ui.theme.fg("accent", s);
		activeEditor = new PiEditor(
			tui,
			editorTheme,
			keybindings,
			currentCursorStyle,
			paint,
		);
		return activeEditor;
	});
	return {
		setCursorStyle(nextCursorStyle: CursorStyle): void {
			currentCursorStyle = nextCursorStyle;
			activeEditor?.setCursorStyle(nextCursorStyle, previousHardwareCursor);
		},
		setWheelScrollLines(nextWheelScrollLines: number): void {
			currentWheelScrollLines = nextWheelScrollLines;
			if (activeTui)
				applyFullscreenWheelScrollLines(activeTui, currentWheelScrollLines);
		},
		cleanup(): void {
			ctx.ui.setEditorComponent(undefined);
			if (activeTui) {
				if (currentCursorStyle !== "block")
					activeTui.terminal.write(DEFAULT_CURSOR_STYLE_SEQUENCE);
				if (previousHardwareCursor !== undefined)
					activeTui.setShowHardwareCursor(previousHardwareCursor);
			}
		},
	};
}

export default function (pi: ExtensionAPI): void {
	let controls: ReturnType<typeof installEditor> | undefined;

	const teardown = (): void => {
		try {
			controls?.cleanup();
		} catch {
			// cleanup is best-effort
		}
		controls = undefined;
		setEditorControls(undefined);
	};

	const apply = (ctx: ExtensionContext): void => {
		const c = getConfig();
		if (!c.enabled || !c.modules.editor) {
			teardown();
			return;
		}
		if (!isTuiContext(ctx)) return;
		if (!controls) {
			controls = installEditor(
				pi,
				ctx,
				c.cursorStyle,
				c.fullscreen.wheelScrollLines,
			);
			setEditorControls(controls);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		apply(ctx);
	});

	subscribeConfig(() => {
		const c = getConfig();
		controls?.setCursorStyle(c.cursorStyle);
		controls?.setWheelScrollLines(c.fullscreen.wheelScrollLines);
	});

	pi.on("session_shutdown", () => {
		teardown();
	});
}
