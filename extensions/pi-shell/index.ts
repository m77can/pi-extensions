import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import * as pty from "@lydell/node-pty";
import {
	Terminal as XTerm,
	type IBufferLine,
} from "@xterm/headless";
import { getConfig } from "../../shared/pi-tui-store.js";
import { truncateToWidth } from "../../shared/utils.js";

/**
 * pi-shell — an embedded terminal panel inside pi (IDE-style).
 *
 * `/shell` swaps the editor slot for a split-panel hosting a REAL interactive
 * shell (pty via @lydell/node-pty): the chat stays on top and the shell
 * occupies the bottom area, like a tui IDE split. Keystrokes are forwarded to
 * the pty; its output is rendered through @xterm/headless, including per-cell
 * colors re-emitted as SGR — so zsh autosuggestions keep their grey look and
 * stay distinguishable from real input.
 *
 * Ctrl+G closes the panel (the pty keeps running; /shell reopens it). Esc is
 * forwarded to the shell (vim etc. work). Ctrl+D at the prompt, or
 * session_shutdown, ends the shell.
 */

const TERM_ROWS = 12;
const SHELL_FALLBACK = process.platform === "win32" ? "cmd" : "sh";

/** SGR params for a cell vs previously applied ones ("" = default). */
function cellSgrFor(
	cell: NonNullable<ReturnType<IBufferLine["getCell"]>>,
): number[] {
	const params: number[] = [];
	if (cell.isBold()) params.push(1);
	if (cell.isDim()) params.push(2);
	if (cell.isItalic()) params.push(3);
	if (cell.isUnderline()) params.push(4);
	if (cell.isFgRGB()) {
		const c = cell.getFgColor();
		params.push(38, 2, (c >> 16) & 255, (c >> 8) & 255, c & 255);
	} else if (cell.isFgPalette()) {
		params.push(38, 5, cell.getFgColor());
	}
	if (cell.isBgRGB()) {
		const c = cell.getBgColor();
		params.push(48, 2, (c >> 16) & 255, (c >> 8) & 255, c & 255);
	} else if (cell.isBgPalette()) {
		params.push(48, 5, cell.getBgColor());
	}
	return params;
}

/**
 * Translate an xterm buffer line to text WITH attributes: run-length encode
 * per-cell fg/bg/bold/dim/italic/underline into SGR sequences.
 * `cursorCol` (cell index) gets reverse-video to draw the terminal cursor.
 */
function lineWithSgr(
	line: IBufferLine,
	width: number,
	cursorCol: number | null,
): string {
	const parts: string[] = [];
	let curKey: string | undefined;
	for (let x = 0; x < Math.min(width, line.length); x++) {
		const cell = line.getCell(x);
		if (!cell || cell.getWidth() === 0) continue; // trailing half of CJK
		let chars = cell.getChars() || " ";
		if (x === cursorCol) chars = `\x1b[7m${chars}\x1b[0m`;
		const params = cellSgrFor(cell);
		const key = params.join(";");
		if (key !== curKey) {
			parts.push(
				ParamsToSgr(key === "" ? [0] : [0, ...params]),
			);
			curKey = key;
		}
		parts.push(chars);
	}
	if (curKey !== undefined && curKey !== "") parts.push("\x1b[0m");
	return parts.join("");
}

function ParamsToSgr(params: number[]): string {
	return `\x1b[${params.join(";")}m`;
}

// ── PTY + terminal-emulator session (lives across panel open/close) ───────

class ShellSession {
	private proc: pty.IPty | null = null;
	private xterm: XTerm | null = null;
	private tui: TUI | null = null;
	private cols = 80;
	private emulatorOutput: { dispose(): void } | null = null;

	start(tui: TUI): boolean {
		this.tui = tui;
		if (this.proc) return false;
		const shellCmd = process.env.SHELL?.trim() || SHELL_FALLBACK;
		const term = new XTerm({
			cols: this.cols,
			rows: TERM_ROWS,
			scrollback: 2000,
			allowProposedApi: true,
		});
		const proc = pty.spawn(shellCmd, ["-i"], {
			cwd: process.cwd(),
			cols: this.cols,
			rows: TERM_ROWS,
			env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" },
		});
		this.xterm = term;
		this.proc = proc;
		proc.onData((data: string) => {
			term.write(data);
			this.tui?.requestRender();
		});
		// Emulator-generated OUTPUT → back into the pty: replies to shell
		// queries (cursor position ESC[6n, device attributes ESC[c, OSC
		// queries). Without this loop shells hang/misrender on those.
		this.emulatorOutput?.dispose();
		this.emulatorOutput = term.onData((data: string) => {
			proc.write(data);
		});
		proc.onExit(() => {
			term.write("\r\n[shell exited — Ctrl+G close, /shell restarts]\r\n");
			this.tui?.requestRender();
			this.proc = null;
			this.xterm = null;
		});
		return true;
	}

	alive(): boolean {
		return this.proc !== null;
	}

	write(data: string): void {
		this.proc?.write(data);
	}

	/**
	 * Translate pi key events to the canonical byte sequence the shell's
	 * current keypad mode expects. DECCKM comes straight from the emulator:
	 * `this.xterm.modes.applicationCursorKeysMode` is xterm.js's own parsed
	 * SM/DECSET state (`CSI ? 1 h/l`) — no separate state machine needed.
	 * Ordinary characters arrive raw and pass through unchanged.
	 */
	private keypadMode(): boolean {
		return this.xterm?.modes.applicationCursorKeysMode ?? false;
	}

	private keyToBytes(data: string): string | null {
		const app = this.keypadMode();
		if (matchesKey(data, Key.up)) return app ? "\x1bOA" : "\x1b[A";
		if (matchesKey(data, Key.down)) return app ? "\x1bOB" : "\x1b[B";
		if (matchesKey(data, Key.right)) return app ? "\x1bOC" : "\x1b[C";
		if (matchesKey(data, Key.left)) return app ? "\x1bOD" : "\x1b[D";
		if (matchesKey(data, Key.home)) return app ? "\x1bOH" : "\x1b[H";
		if (matchesKey(data, Key.end)) return app ? "\x1bOF" : "\x1b[F";
		if (matchesKey(data, Key.delete)) return "\x1b[3~";
		if (matchesKey(data, Key.insert)) return "\x1b[2~";
		if (matchesKey(data, Key.backspace)) return "\x7f";
		if (matchesKey(data, Key.enter)) return "\r";
		if (matchesKey(data, Key.tab)) return "\t";
		if (matchesKey(data, Key.ctrl("c"))) return "\x03";
		if (matchesKey(data, Key.ctrl("d"))) return "\x04";
		if (matchesKey(data, Key.ctrl("z"))) return "\x1a";
		return null;
	}

	/** send data translated through keyToBytes */
	sendKey(data: string): void {
		// Bracketed paste: shell enables CSI ? 2004 h; the terminal must wrap
		// pasted text in CSI 200~ / CSI 201~ so the shell buffers it instead
		// of executing every newline. Heuristic: multi-char chunk that is not
		// itself a single recognized key/escape sequence.
		const bpm = this.xterm?.modes.bracketedPasteMode ?? false;
		if (bpm && data.length > 1 && !data.startsWith("\x1b")) {
			this.proc?.write(`\x1b[200~${data}\x1b[201~`);
			return;
		}
		const bytes = this.keyToBytes(data) ?? data;
		this.proc?.write(bytes);
	}

	resize(cols: number): void {
		if (cols < 4 || cols === this.cols) return;
		this.cols = cols;
		this.xterm?.resize(cols, TERM_ROWS);
		this.proc?.resize(cols, TERM_ROWS);
		this.tui?.requestRender();
	}

	kill(): void {
		this.emulatorOutput?.dispose();
		this.emulatorOutput = null;
		if (!this.proc) return;
		try {
			this.proc.kill();
		} catch {
			// child already gone
		}
		this.proc = null;
		this.xterm = null;
	}

	visibleLines(width: number): string[] {
		const term = this.xterm;
		if (!term) return [];
		const buf = term.buffer.active;
		const total = buf.length;
		const start = Math.max(0, total - TERM_ROWS);
		const out: string[] = [];
		for (let i = start; i < total; i++) {
			const line = buf.getLine(i);
			if (!line || line.isWrapped) continue;
			const cursorCol = i === buf.cursorY ? buf.cursorX : null;
			const text = lineWithSgr(
				line,
				Math.min(width, this.cols),
				cursorCol,
			).replace(/\s+$/g, "");
			out.push(truncateToWidth(text, width, ""));
		}
		return out;
	}
}

// ── Panel component (Container + DynamicBorder, rounded by pi-chrome) ─────

class LinesComponent implements Component {
	constructor(private readonly getLines: (width: number) => string[]) {}
	invalidate(): void {}
	render(width: number): string[] {
		return this.getLines(width);
	}
}

let session: ShellSession | null = null;

export default function piShell(pi: ExtensionAPI): void {
	const config = getConfig();
	if (!config.enabled || !config.modules.shell) return;

	pi.on("session_shutdown", () => {
		session?.kill();
		session = null;
	});

	pi.registerCommand("shell", {
		description: "Open an embedded shell panel (IDE-style)",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
			if (!session) session = new ShellSession();

			await ctx.ui.custom<undefined>(
				(tui: TUI, theme: Theme, _kb, done) => {
					const sh = session as ShellSession;
					sh.start(tui);
					const dim = (s: string) => theme.fg("dim", s);
					const paint = (s: string) => theme.fg("accent", s);
					const muted = (s: string) => theme.fg("muted", s);

					return {
						render: (w: number) => {
							sh.resize(w - 2);
							const inner = Math.max(1, w - 2);
							const content: string[] = [
								paint("pi-shell"),
								dim("─".repeat(inner)),
								...sh.visibleLines(inner),
								muted("Ctrl+G close · shell keeps running"),
							];
							const container = new Container();
							container.addChild(new DynamicBorder(paint));
							container.addChild(new LinesComponent(() => content));
							container.addChild(new DynamicBorder(paint));
							return container.render(w);
						},
						invalidate: () => {},
						handleInput: (data: string) => {
							if (matchesKey(data, Key.ctrl("g"))) {
								done(undefined);
								return;
							}
							sh.sendKey(data);
							tui.requestRender();
						},
						dispose: () => {},
					};
				},
			);
		},
	});
}