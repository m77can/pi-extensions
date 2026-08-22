import { spawn } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { getConfig } from "../../shared/pi-tui-store.js";

/**
 * pi-shell — run an interactive shell inside pi without leaving the session.
 *
 * Registers the `/shell` command: suspends the TUI (tui.stop), spawns the
 * user's login shell with stdio inherit — full readline history/prompt,
 * aliases from the shell rc — and resumes the TUI when the shell exits.
 *
 * Same lifecycle the kernel uses for Ctrl+G external editors (ui.stop →
 * child process → ui.start), so fullscreen TUI apps like vim work the same.
 */
const SHELL_FALLBACK = process.platform === "win32" ? "cmd" : "sh";

export default function piShell(pi: ExtensionAPI): void {
	const config = getConfig();
	if (!config.enabled || !config.modules.shell) return;

	pi.registerCommand("shell", {
		description: "Suspend pi and run an interactive shell (exit to return)",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
			await ctx.ui.custom<undefined>((tui: TUI, _theme, _kb, done) => {
				const shellCmd =
					process.env.SHELL?.trim() || `"${SHELL_FALLBACK}"`;
				tui.stop();
				let finished = false;
				const resume = () => {
					if (finished) return;
					finished = true;
					tui.start();
					tui.requestRender(true);
					done(undefined);
				};
				const child = spawn(shellCmd, [], {
					stdio: "inherit",
					shell: true,
				});
				child.on("exit", resume);
				child.on("error", resume);
				return {
					render: () => [],
					invalidate: () => {},
					dispose: resume,
				};
			});
			// After resume the kernel restores the editor and focus; nothing
			// further to do — the shell ran with the user's own rc/history.
		},
	});
}