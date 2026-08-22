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
import { Terminal as XTerm } from "@xterm/headless";
import { getConfig } from "../../shared/pi-tui-store.js";
import { truncateToWidth } from "../../shared/utils.js";

/**
 * pi-shell — an embedded terminal panel inside pi (IDE-style).
 *
 * `/shell` opens a right-side overlay panel hosting a REAL interactive shell
 * (pty via @lydell/node-pty). pi's TUI stays visible; keystrokes go to the
 * pty. Output is rendered through @xterm/headless — a maintained terminal
 * emulator — so prompt redraws, line editing, colors and cursor movement are
 * handled like a real terminal instead of being hand-parsed.
 *
 * The pty survives panel close/reopen (Esc closes, shell keeps running).
 * Ctrl+D at the prompt exits the shell; session_shutdown kills it.
 */

const PANEL_ROWS = 12;
const SHELL_FALLBACK = process.platform === "win32" ? "cmd" : "sh";

// ── PTY + terminal-emulator session (lives across panel open/close) ───────

class ShellSession {
	private proc: pty.IPty | null = null;
	private xterm: XTerm | null = null;
	private tui: TUI | null = null;
	private cols = 80;

	start(tui: TUI): boolean {
		this.tui = tui;
		if (this.proc) return false;
		const shellCmd = process.env.SHELL?.trim() || SHELL_FALLBACK;
		const term = new XTerm({
			cols: this.cols,
			rows: PANEL_ROWS,
			scrollback: 2000,
			allowProposedApi: true,
		});
		const proc = pty.spawn(shellCmd, ["-i"], {
			cwd: process.cwd(),
			cols: this.cols,
			rows: PANEL_ROWS,
			env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" },
		});
		this.xterm = term;
		this.proc = proc;
		proc.onData((data: string) => {
			term.write(data);
			this.tui?.requestRender();
		});
		proc.onExit(() => {
			term.write("\r\n[shell exited — reopen /shell to restart]\r\n");
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

	resize(cols: number): void {
		if (cols < 4 || cols === this.cols) return;
		this.cols = cols;
		this.xterm?.resize(cols, PANEL_ROWS);
		this.proc?.resize(cols, PANEL_ROWS);
		this.tui?.requestRender();
	}

	kill(): void {
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
		const out: string[] = [];
		for (let i = Math.max(0, total - PANEL_ROWS); i < total; i++) {
			const line = buf.getLine(i);
			if (!line || line.isWrapped) continue;
			const text = line.translateToString(false).replace(/\s+$/g, "");
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
								muted("Esc close · shell keeps running"),
							];
							const container = new Container();
							container.addChild(new DynamicBorder(paint));
							container.addChild(new LinesComponent(() => content));
							container.addChild(new DynamicBorder(paint));
							return container.render(w);
						},
						invalidate: () => {},
						handleInput: (data: string) => {
							if (matchesKey(data, Key.escape)) {
								done(undefined);
								return;
							}
							sh.write(data);
							tui.requestRender();
						},
						dispose: () => {},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: "45%",
						minWidth: 30,
						maxHeight: "85%",
						margin: { top: 2, bottom: 2, left: 0, right: 1 },
					},
				},
			);
		},
	});
}