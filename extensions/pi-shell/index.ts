import { spawn, type ChildProcess } from "node:child_process";
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
import { getConfig } from "../../shared/pi-tui-store.js";
import { stripAnsi, truncateToWidth } from "../../shared/utils.js";

/**
 * pi-shell — an embedded terminal panel inside pi (IDE-style).
 *
 * `/shell` opens a right-side overlay panel hosting a REAL interactive shell:
 * pi's TUI stays visible and interactive; keystrokes are forwarded to the
 * shell's pty and its output renders inside the panel. The shell process is
 * created once per pi session and survives panel close/reopen, so cwd and
 * in-memory state persist; your normal ~/.zsh_history etc. work as usual.
 *
 * PTY: the host `script -q /dev/null $SHELL` utility provides the pty
 * (node-pty is not a pi dependency). Fallback (no script binary) still
 * forwards I/O, just without line editing.
 *
 * Close the panel with Esc (the shell keeps running); kill the shell with
 * Ctrl+D at an empty prompt, or when the session shuts down.
 */

const MAX_LINES = 300;
const SHELL_FALLBACK = process.platform === "win32" ? "cmd" : "sh";

// ── Shell session (lives across panel open/close) ─────────────────────────

class ShellSession {
	private child: ChildProcess | null = null;
	private buf = "";
	private lines: string[] = [];
	private tui: TUI | null = null;

	start(tui: TUI): boolean {
		this.tui = tui;
		if (this.child) return false;
		const shellCmd = process.env.SHELL?.trim() || SHELL_FALLBACK;
		// script(1) hands the child a real tty → line editing, history, prompt.
		const child = spawn(
			"script",
			["-q", "/dev/null", shellCmd, "-i"],
			{
				stdio: "pipe",
				cwd: process.cwd(),
				env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" },
			},
		);
		this.child = child;
		child.stdout?.on("data", (chunk: Buffer) => this.ingest(chunk));
		child.stderr?.on("data", (chunk: Buffer) => this.ingest(chunk));
		child.on("exit", () => {
			this.ingest("\n[shell exited — reopen /shell to restart]\n");
			this.child = null;
			this.tui?.requestRender();
		});
		return true;
	}

	alive(): boolean {
		return this.child !== null;
	}

	write(data: string): void {
		this.child?.stdin?.write(data);
	}

	kill(): void {
		if (!this.child) return;
		this.child.stdin?.end();
		this.child.kill();
		this.child = null;
	}

	private ingest(chunk: Buffer | string): void {
		this.buf += chunk.toString();
		let idx: number;
		while ((idx = this.buf.indexOf("\n")) !== -1) {
			let line = this.buf.slice(0, idx);
			// The pty echoes carriage returns; keep lines clean for display.
			line = line.replace(/\r/g, "").replace(/\x1b[^a-zA-Z]*[a-zA-Z]/g, "");
			this.lines.push(stripAnsi(line));
			this.buf = this.buf.slice(idx + 1);
		}
		if (this.lines.length > MAX_LINES)
			this.lines.splice(0, this.lines.length - MAX_LINES);
		this.tui?.requestRender();
	}

	visibleLines(maxRows: number, width: number): string[] {
		return this.lines
			.slice(-maxRows)
			.map((l) => truncateToWidth(l, width, ""));
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
							const inner = Math.max(1, w - 2);
							const rows = Math.max(6, 12);
							const content: string[] = [
								paint("pi-shell"),
								dim("─".repeat(inner)),
								...sh.visibleLines(rows - 2, inner),
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
								// Close the panel; the shell process keeps running.
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