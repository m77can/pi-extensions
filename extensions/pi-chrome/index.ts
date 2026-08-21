import {
	DynamicBorder,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getConfig } from "../../shared/pi-tui-store.js";

/**
 * pi-chrome — round the "two horizontal line" system panels (update notice,
 * changelog, /reload box, hotkeys, /settings, selectors) into complete
 * `╭──╮ │ │ ╰──╯` frames, matching the pi-editor input.
 *
 * One patch point: `Container.prototype.render`. For each container we:
 *   1. pre-scan direct children that are DynamicBorders;
 *   2. pair them top/bottom in addChild order — an odd middle border (tree
 *      selector uses three) stays a straight line; a lone border also stays
 *      straight;
 *   3. inside a frame: render content children at width-2 and wrap every line
 *      with │ … │, padded to full width (ANSI-aware);
 *   4. top/bottom draw ╭ ── ╮ / ╰ ── ╯, all colored through the border's own
 *      `color` fn so themes (border/warning/accent) keep working.
 *
 * Module identity note: top-level imports of `@earendil-works/pi-coding-agent`
 * and `@earendil-works/pi-tui` resolve to the same module instances the pi
 * kernel itself uses, so patching the exported prototypes here rewrites the
 * classes pi actually constructs selectors/dialogs from. (Verified by probe
 * against pi v0.84.2 — the jiti alias for pi-tui and the kernel's own import
 * of it land on the same dist file.)
 */
export default function piChrome(_pi: ExtensionAPI): void {
	const config = getConfig();
	if (!config.enabled || !config.chrome) return;

	const borderClass = DynamicBorder;
	const ContainerCtor = Container;

	const ContainerProto = ContainerCtor.prototype;
	const originalRender = ContainerProto.render;

	if (typeof originalRender !== "function") return;

	const isBorder = (child: unknown): boolean => {
		if (typeof child !== "object" || child === null) return false;
		// SAFETY: constructor identity via the same prototype duck-check pi
		// itself relies on across its module boundaries.
		const ctor = (child as { constructor?: { prototype?: unknown } }).constructor;
		return ctor?.prototype === borderClass.prototype;
	};

	function cornerLine(width: number, kind: "top" | "bottom"): string {
		if (width <= 0) return "";
		if (width === 1) return kind === "top" ? "╭" : "╰";
		const body = "─".repeat(Math.max(0, width - 2));
		return kind === "top" ? `╭${body}╮` : `╰${body}╯`;
	}

	function frameLine(
		content: string,
		innerWidth: number,
		paint: (t: string) => string,
	): string | null {
		if (innerWidth < 0) return null;
		const vis = visibleWidth(content);
		const clipped =
			vis > innerWidth
				? truncateToWidth(content, innerWidth, "")
				: content + " ".repeat(innerWidth - vis);
		// Rails share the frame's own color fn — same shade and weight as the
		// top/bottom borders, exactly like PiEditor's rail does.
		return `${paint("│")}${clipped}${paint("│")}`;
	}

	// SAFETY: the patched function below mirrors the original Container.render
	// (children → lines) and delegates unchanged when no border frames exist.
	ContainerProto.render = function chromeRender(
		this: { children: unknown[] },
		width: number,
	): string[] {
		const children: unknown[] = this.children ?? [];

		const borderIndices: number[] = [];
		for (let i = 0; i < children.length; i++) {
			if (isBorder(children[i])) borderIndices.push(i);
		}

		// No frames: delegate exactly to the original render.
		if (borderIndices.length < 2) {
			return originalRender.call(this, width);
		}

		// Odd middle border (tree selector) stays straight.
		const oddMiddle =
			borderIndices.length % 2 === 1
				? (borderIndices[Math.floor(borderIndices.length / 2)] ?? -1)
				: -1;
		const firstBorder = borderIndices[0] ?? -1;
		const lastBorder = borderIndices[borderIndices.length - 1] ?? -1;

		const innerWidth = Math.max(1, width - 2);
		const lines: string[] = [];
		let ordinal = 0;
		// The active frame's paint fn — used for both the top/bottom borders and
		// the side rails so every glyph matches in color and weight.
		let framePaint: (t: string) => string = (t) => t;

		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			if (isBorder(child)) {
				ordinal++;
				const paint = (child as { color: (t: string) => string }).color;
				framePaint = paint;
				if (i === oddMiddle) {
					lines.push(paint("─".repeat(Math.max(1, width))));
				} else {
					const isTop =
						ordinal % 2 === 1 &&
						i !== lastBorder &&
						!oddMiddleIsBottom(ordinal, borderIndices.length, oddMiddle);
					lines.push(
						paint(isTop ? cornerLine(width, "top") : cornerLine(width, "bottom")),
					);
				}
				continue;
			}

			const inFrame = i >= firstBorder && i <= lastBorder;
			if (!inFrame) {
				for (const line of (child as { render: (w: number) => string[] }).render(
					width,
				)) {
					lines.push(line);
				}
				continue;
			}

			// In-frame content: render narrower, then pad + rails. The rail
			// pixels inherit the frame's border paint for identical shade/weight.
			const childLines = (child as { render: (w: number) => string[] }).render(
				innerWidth,
			);
			for (const line of childLines) {
				const railed = frameLine(line, innerWidth, framePaint);
				if (railed !== null) lines.push(railed);
			}
		}
		return lines;
	};
}

/** When 3 borders, ordinal 2 is the straight middle → ordinal 3 is bottom. */
function oddMiddleIsBottom(
	ordinal: number,
	total: number,
	oddMiddle: number,
): boolean {
	if (oddMiddle < 0) return false;
	return total % 2 === 1 && ordinal === total;
}
