import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { PiTuiConfig } from "./config.js";

export type { BorderStyle } from "./config.js";

/**
 * Resolve the border paint function for all pi-tui chrome (header, editor,
 * settings) from the configured `borderStyle`.
 *
 * - accent   → theme accent color (unified cyan)
 * - thinking → theme.getThinkingBorderColor(level) (follows thinking level)
 * - default  → pi's default behavior: no override (caller should fall back to
 *              its own default, e.g. editor's mutable borderColor)
 */
export function resolveBorderPaint(
	config: PiTuiConfig,
	theme: Theme,
	level: ThinkingLevel | string | undefined,
): ((s: string) => string) | null {
	switch (config.borderStyle) {
		case "accent":
			return (s: string) => theme.fg("accent", s);
		case "thinking":
			return (s: string) =>
				theme.getThinkingBorderColor((level as ThinkingLevel) ?? "off")(s);
		case "default":
			return null;
	}
}