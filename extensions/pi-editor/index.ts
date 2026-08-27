import {
	CustomEditor,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	truncateToWidth,
	type Component,
	type EditorTheme,
	type TUI,
	Container,
} from "@earendil-works/pi-tui";
import type { CursorStyle } from "../../shared/config.js";
import {
	applyFullscreenWheelScrollLines,
	DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
} from "../../shared/fullscreen-scroll.js";
import { findBottomBorderIndex, stripAnsi } from "../../shared/utils.js";
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

/** Scroll label the stock editor embeds in its border lines: `↑ N more`. */
const SCROLL_LABEL_RE = /([↑↓]\s+\d+\s+more)/;

function extractScrollLabel(line: string | undefined): string {
	if (!line) return "";
	const match = stripAnsi(line).match(SCROLL_LABEL_RE);
	return match ? `\x1b[2m${match[1]}\x1b[0m` : "";
}

/** Thin Component adapter around pre-rendered lines. */
class LinesComponent implements Component {
	constructor(private readonly getLines: (width: number) => string[]) {}
	invalidate(): void {}
	render(width: number): string[] {
		return this.getLines(width);
	}
}

/**
 * PiEditor — the stock multiline editor, framed by a Container with two
 * DynamicBorder children. pi-chrome's `Container.prototype.render` patch pairs
 * those borders into the ╭─╮ rounded frame and rails the rows in between, so
 * this class carries no per-editor corner/rail painting of its own.
 *
 * The frame color reads `this.borderColor` at render time (closure), so
 * thinking-level / bash-mode recolors keep working like the built-in editor.
 *
 * IMPORTANT: render() must re-run `super.render` on EVERY call — the stock
 * editor re-lays out its text each render, and the TUI calls render() directly
 * after keystrokes (it does not invalidate). Caching base lines per width here
 * made fresh keystrokes invisible (stale lines) — do not add a cache back.
 */
export class PiEditor extends CustomEditor {
	private cursorStyle: CursorStyle;
	private previewHardwareCursor = false;
	private enterInsertsCompletion: boolean;
	private readonly keybindingsManager: KeybindingsManager;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		cursorStyle: CursorStyle = "block",
		enterInsertsCompletion = true,
	) {
		super(tui, editorTheme, keybindings, { paddingX: 0 });
		this.cursorStyle = cursorStyle;
		this.enterInsertsCompletion = enterInsertsCompletion;
		this.keybindingsManager = keybindings;
		configureCursor(tui, cursorStyle);
	}

	/**
	 * Upstream `Editor` treats Enter (tui.select.confirm) on an open
	 * autocomplete popup as "apply + immediately submit" when the completion
	 * prefix starts with "/" (slash command / skill). Route that keystroke
	 * through Tab instead, which applies the selection and keeps the editor
	 * open so arguments can be typed afterwards.
	 */
	override handleInput(data: string): void {
		if (
			this.enterInsertsCompletion &&
			this.isShowingAutocomplete() &&
			this.keybindingsManager.matches(data, "tui.select.confirm")
		) {
			super.handleInput("\t");
			return;
		}
		super.handleInput(data);
	}

	setEnterInsertsCompletion(enterInsertsCompletion: boolean): void {
		this.enterInsertsCompletion = enterInsertsCompletion;
	}

	override setPaddingX(_padding: number): void {
		// The container frame owns the inset; keep a stable full-width layout.
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

	/** Stock editor output: border / content / border / autocomplete tail. */
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

		// Layout stock content at the frame's inner width (rails take 2 cols).
		const innerWidth = Math.max(1, width - 2);
		// Fresh every frame: the stock editor's layout lives inside
		// super.render; caching here hides keystrokes (see class doc).
		const baseLines = this.renderBase(innerWidth);
		const bottomIdx = findBottomBorderIndex(baseLines);
		const topLabel = extractScrollLabel(baseLines[0]);
		const bottomLabel = extractScrollLabel(baseLines[bottomIdx]);
		const bodyLines = baseLines.slice(1, Math.max(1, bottomIdx));
		const tailLines = baseLines.slice(Math.max(0, bottomIdx + 1));

		const paint = (s: string) => this.borderColor(s);
		const container = new Container();
		container.addChild(new DynamicBorder(paint));
		if (topLabel) container.addChild(new LinesComponent(() => [topLabel]));
		container.addChild(new LinesComponent(() => bodyLines));
		if (bottomLabel) container.addChild(new LinesComponent(() => [bottomLabel]));
		container.addChild(new DynamicBorder(paint));
		// Autocomplete popup renders below the frame, at full width (children
		// after the last border are exempt from rails in the patch).
		if (tailLines.length > 0)
			container.addChild(new LinesComponent(() => tailLines));

		return container
			.render(width)
			.map((line) => truncateToWidth(line, width, ""));
	}
}

export function installEditor(
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
	cursorStyle: CursorStyle = "block",
	wheelScrollLines = DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
	enterInsertsCompletion = true,
) {
	let activeTui: TUI | undefined;
	let activeEditor: PiEditor | undefined;
	let previousHardwareCursor: boolean | undefined;
	let currentCursorStyle = cursorStyle;
	let currentWheelScrollLines = wheelScrollLines;
	let currentEnterInsertsCompletion = enterInsertsCompletion;

	ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
		activeTui = tui;
		applyFullscreenWheelScrollLines(tui, currentWheelScrollLines);
		previousHardwareCursor = tui.getShowHardwareCursor();
		activeEditor = new PiEditor(
			tui,
			editorTheme,
			keybindings,
			currentCursorStyle,
			currentEnterInsertsCompletion,
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
		setEnterInsertsCompletion(nextEnterInsertsCompletion: boolean): void {
			currentEnterInsertsCompletion = nextEnterInsertsCompletion;
			activeEditor?.setEnterInsertsCompletion(nextEnterInsertsCompletion);
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
				c.autocompleteEnterInserts,
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
		controls?.setEnterInsertsCompletion(c.autocompleteEnterInserts);
	});

	pi.on("session_shutdown", () => {
		teardown();
	});
}
