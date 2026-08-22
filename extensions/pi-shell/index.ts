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
import { truncateToWidth } from "../../shared/utils.js";

/**
 * pi-shell — an embedded terminal panel inside pi (IDE-style).
 *
 * `/shell` opens a right-side overlay panel hosting a REAL interactive shell:
 * pi's TUI stays visible and interactive; keystrokes are forwarded to the
 * shell's pty and its output renders inside the panel. The shell process is
 * created once per pi session and survives panel close/reopen, so cwd and
 * in-memory state persist; your normal ~/.zsh_history etc. work as usual.
 *
 * PTY: the host `python3 pty.spawn()` provides the pty (node-pty is not a pi
 * dependency and macOS `script(1)` fails on socket stdio — Node pipes are
 * sockets here — with "tcgetattr: Operation not supported on socket").
 * Fallback: direct spawn without a pty (no line editing).
 *
 * Close the panel with Esc (the shell keeps running); kill the shell with
 * Ctrl+D at an empty prompt, or when the session shuts down.
 */

const MAX_LINES = 300;
const SHELL_FALLBACK = process.platform === "win32" ? "cmd" : "sh";

const ESC = "\u001b";
const BS = "\u0008";
const CR = "\r";
const BEL = "\u0007";
const ST = ESC + "\\";

/**
 * Clean a chunk of pty output for plain-line display: drop CSI/OSC control
 * sequences, honor backspace erasing, remove carriage returns.
 */
function sanitizeTerminalText(text: string): string {
	let out = text
		// OSC sequences (window title etc.): ESC ] ... BEL/ST
		.replace(new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ST})`, "g"), "")
		// Generic CSI: ESC [ params letter (SGR, cursor moves, bracketed paste…)
		.replace(new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g"), "")
		// Any other escape lead
		.replace(new RegExp(`${ESC}[()=>~\\u007f]`, "g"), "");
	// Backspace erases the previous character (readline echo).
	while (out.includes(BS)) {
		const pos = out.indexOf(BS);
		out = pos === 0 ? out.slice(1) : out.slice(0, pos - 1) + out.slice(pos + 1);
	}
	return out.replace(new RegExp(CR, "g"), "");
}

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
		const env = {
			...process.env,
			TERM: process.env.TERM ?? "xterm-256color",
			PI_SHELL_ARGV: JSON.stringify([shellCmd, "-i"]),
		};
		const ptyCode = [
			"import json, os, pty",
			"pty.spawn(json.loads(os.environ['PI_SHELL_ARGV']))",
		].join(";");
		const child = spawn("python3", ["-c", ptyCode], {
			stdio: "pipe",
			cwd: process.cwd(),
			env,
		});
		child.on("error", () => {
			// No python3: last-resort direct spawn (no tty).
			this.child = spawn(shellCmd, ["-i"], {
				stdio: "pipe",
				cwd: process.cwd(),
				env,
			});
		});
		this.child = child;
		this.child.stdout?.on("data", (chunk: Buffer) => this.ingest(chunk));
		this.child.stderr?.on("data", (chunk: Buffer) => this.ingest(chunk));
		this.child.on("exit", () => {
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
			const line = sanitizeTerminalText(this.buf.slice(0, idx));
			if (line.length > 0) this.lines.push(line);
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
							const out = sh.visibleLines(rows - 2, inner);
							const content: string[] = [
								paint("pi-shell"),
								dim("─".repeat(inner)),
								...out,
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