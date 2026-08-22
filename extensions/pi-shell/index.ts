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
import { getConfig } from "../../shared/pi-tui-store.js";
import { truncateToWidth } from "../../shared/utils.js";

/**
 * pi-shell — an embedded terminal panel inside pi (IDE-style).
 *
 * `/shell` opens a right-side overlay panel hosting a REAL interactive shell
 * via @lydell/node-pty (a maintained node-pty fork with prebuilt binaries):
 * pi's TUI stays visible; keystrokes go to the pty, its output renders in the
 * panel. The pty survives panel close/reopen, so cwd and state persist, and
 * your normal shell rc/history work.
 *
 * Close the panel with Esc (shell keeps running); exit the shell with Ctrl+D;
 * kill on session_shutdown.
 */

const MAX_LINES = 300;
const SHELL_FALLBACK = process.platform === "win32" ? "cmd" : "sh";

/**
 * Clean pty output for plain-line display: strip CSI/OSC escapes and honor
 * backspace erasing. State-machine based — no regex (control chars in regex
 * literals broke earlier).
 */
function sanitizeTerminalText(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text.charCodeAt(i);
		if (c === 0x1b) {
			// Escape sequence.
			i++;
			const next = text.charCodeAt(i);
			if (next === 0x5b) {
				// CSI: skip until final byte (0x40–0x7e).
				i++;
				while (i < text.length) {
					const cc = text.charCodeAt(i);
					if (cc >= 0x40 && cc <= 0x7e) {
						i++;
						break;
					}
					i++;
				}
			} else if (next === 0x5d || next === 0x50 || next === 0x5f || next === 0x58 || next === 0x5e) {
				// OSC/PM/APC/SOS DCS: skip until BEL (0x07) or ST (ESC \).
				i++;
				while (i < text.length) {
					const cc = text.charCodeAt(i);
					if (cc === 0x07) {
						i++;
						break;
					}
					if (cc === 0x1b) {
						i++;
						break;
					}
					i++;
				}
			} else {
				// Single-char escape (e.g. ESC c): consume the lead only.
			}
			continue;
		}
		if (c === 0x08) {
			// Backspace erases previous char (readline echo).
			if (out.length > 0) out = out.slice(0, -1);
			i++;
			continue;
		}
		if (c === 0x0d) {
			// CR: pty emits \r\n; we split on \n, drop the \r.
			i++;
			continue;
		}
		if (c === 0x09) {
			out += " ";
			i++;
			continue;
		}
		out += text[i];
		i++;
	}
	return out;
}

// ── PTY session (lives across panel open/close) ───────────────────────────

class ShellSession {
	private proc: pty.IPty | null = null;
	private buf = "";
	private lines: string[] = [];
	private tui: TUI | null = null;

	start(tui: TUI): boolean {
		this.tui = tui;
		if (this.proc) return false;
		const shellCmd = process.env.SHELL?.trim() || SHELL_FALLBACK;
		const proc = pty.spawn(shellCmd, ["-i"], {
			cwd: process.cwd(),
			cols: 80,
			rows: 24,
			env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" },
		});
		this.proc = proc;
		proc.onData((data: string) => this.ingest(data));
		proc.onExit(() => {
			this.ingest("\n[shell exited — reopen /shell to restart]\n");
			this.proc = null;
			this.tui?.requestRender();
		});
		return true;
	}

	alive(): boolean {
		return this.proc !== null;
	}

	write(data: string): void {
		this.proc?.write(data);
	}

	kill(): void {
		if (!this.proc) return;
		try {
			this.proc.kill();
		} catch {
			// child already gone
		}
		this.proc = null;
	}

	private ingest(chunk: string): void {
		this.buf += chunk;
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