import {
	getPackageDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { getConfig } from "../../shared/pi-tui-store.js";

interface DynamicBorderClass {
	prototype: {
		color: (text: string) => string;
		invalidate: () => void;
		render: (width: number) => string[];
	};
}

interface ContainerClass {
	prototype: {
		addChild: (component: unknown) => void;
	};
}

const MARK = "__piChromeBorderKind";

/**
 * pi-chrome — round the "two horizontal line" system panels (changelog,
 * update notice, /reload box, hotkeys, /settings) into `╭─` / `╰─` corners.
 *
 * The kernel's DynamicBorder just draws `────`. Every framed panel adds a run
 * of two of them to the same Container. We patch `Container.prototype.addChild`
 * to number them per-container (first = top, second = bottom, repeat) and
 * patch `DynamicBorder.prototype.render` to use the rounded corners.
 *
 * `ctx.ui.custom()` is the official extension UI surface and `CustomEditor`
 * the editor surface; there is no vendor hook for the kernel panels, so this
 * patches the component prototypes instead. The ordinal comes from the actual
 * addChild sequence, so a re-render never flips it (unlike a global counter).
 */
export default function piChrome(_pi: ExtensionAPI): void {
	const config = getConfig();
	if (!config.enabled || !config.chrome) return;

	const agentPackage = getPackageDir();
	const kernelBorderPath = `${agentPackage}/dist/modes/interactive/components/dynamic-border.js`;
	const tuiPath = `${agentPackage}/node_modules/@earendil-works/pi-tui/dist/tui.js`;

	// SAFETY — createRequire resolves the exact same dist file the kernel
	// eval'd through Node's native require cache, so the class we patch is the
	// one interactive-mode constructs. A jiti alias import would give a copy
	// under jiti's separate module cache, which would NOT affect the kernel.
	const req = createRequire(import.meta.url);

	let borderModule: { DynamicBorder: DynamicBorderClass } | undefined;
	let tuiModule: { Container: ContainerClass } | undefined;
	try {
		borderModule = req(kernelBorderPath) as { DynamicBorder: DynamicBorderClass };
	} catch {
		// best-effort: kernel layout moved across pi versions
		return;
	}
	try {
		tuiModule = req(tuiPath) as { Container: ContainerClass };
	} catch {
		// best-effort
	}

	const borderClass = borderModule?.DynamicBorder;

	if (borderClass) {
		borderClass.prototype.render = function roundedRender(width: number) {
			// SAFETY: MARK is written above in addChild before render; the default
			// 1 covers any single-line usage. Rendering only reads, never mutates.
			const kind = (this as unknown as { [MARK]?: 1 | 2 })[MARK] ?? 1;
			if (kind === 1) return [roundTop(width)];
			return [roundBottom(width)];
		};
	}

	if (tuiModule && borderClass) {
		const { Container } = tuiModule;
		const originalAddChild = Container.prototype.addChild;
		Container.prototype.addChild = function chromeAddChild(
			component: unknown,
		): void {
			// SAFETY — `component` is the kernel's own DynamicBorder instance at
			// the time addChild is called; matching by constructor prototype is
			// the same duck-typing pi itself uses across module boundaries.
			const anyComponent = component as {
				constructor?: { prototype?: unknown };
			};
			if (anyComponent?.constructor?.prototype === borderClass.prototype) {
				// SAFETY: `component` is the kernel's own DynamicBorder instance
				// right now; it carries an unchecked runtime shape in typings only.
				const marked = component as unknown as { [MARK]?: 1 | 2 };
				// SAFETY: `this` is the kernel Container instance during addChild;
				// its children are the kernel's own list of components.
				const container = this as unknown as { children: unknown[] };
				const count = container.children.filter((child) => {
					const c = child as { constructor?: { prototype?: unknown } };
					return c?.constructor?.prototype === borderClass.prototype;
				}).length;
				marked[MARK] = ((count % 2) + 1) as 1 | 2;
			}
			return originalAddChild.call(this, component);
		};
	}
}

function roundTop(width: number): string {
	if (width <= 0) return "";
	if (width === 1) return "╭";
	return `╭${"─".repeat(Math.max(0, width - 2))}╮`;
}

function roundBottom(width: number): string {
	if (width <= 0) return "";
	if (width === 1) return "╰";
	return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}
