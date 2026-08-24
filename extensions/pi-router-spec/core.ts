/**
 * pi-router-spec core — dependency-free pure helpers for the recon rewrite.
 * Kept free of local imports (shared/*.js needs pi's jiti loader) so plain
 * `node --test` can import this module directly.
 *
 * Tool-entry extraction understands every payload generation pi has shipped:
 *   - OpenAI style:   { type: "function", function: { name, ... } }
 *   - Anthropic style: { name, description, input_schema }
 *   - Responses style: { type, name, description, parameters }   (current)
 * Message rewriting handles both carriers:
 *   - legacy: top-level `messages` (+ optional top-level `system`)
 *   - current: Responses `input` array (system message inside)
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// 从 pi 构建好的 provider payload 中按 name 找到内置工具条目（read / bash）,
// 原样复用：
// 找不到目标工具（pi 未启用 / 非 agent 请求）→ 返回 undefined, 调用方放弃重构:
// pi 没带某工具, 本插件也绝不自造一个 pi 执行不了的工具。
export function extractTool(
	tools: unknown,
	toolName: string,
): Record<string, unknown> | undefined {
	if (!Array.isArray(tools)) return undefined;
	for (const tool of tools) {
		if (typeof tool !== "object" || tool === null) continue;
		const entry = tool as Record<string, unknown>;
		// OpenAI 风格: function.name === toolName
		const fn = entry.function;
		if (
			typeof fn === "object" &&
			fn !== null &&
			(fn as Record<string, unknown>).name === toolName
		) {
			return entry;
		}
		// Anthropic 风格: name === toolName 且带 input_schema
		if (
			entry.name === toolName &&
			entry.input_schema &&
			typeof entry.input_schema === "object"
		) {
			return entry;
		}
		// 新 pi Responses 风格: 平铺 { type, name, description, parameters }
		if (entry.name === toolName && typeof entry.parameters === "object") {
			return entry;
		}
	}
	return undefined;
}

// RECON_SYS 模板（极简）: 按用户要求 system 只写一句, 其他一律不加。
// 保留原签名（ctx / reconToolNames）仅为调用方不变。
export function buildReconSys(
	_ctx: ExtensionContext,
	_reconToolNames: string[],
): string {
	return "You are a helpful software engineer assistant.";
}

export function rewriteForRecon(
	payload: Record<string, unknown>,
	reconSys: string,
	reconTools: Array<Record<string, unknown>>,
): Record<string, unknown> {
	const recon = { ...payload };

	// 1) tools：只留 read（+ bash, 若 pi 提供了）
	recon.tools = reconTools;

	// 2) system：整体替换（独立 system 字段：Anthropic / OpenAI Responses 风格）
	if (typeof recon.system === "string" || recon.system !== undefined) {
		recon.system = reconSys;
	}

	// 3) messages：只保留 user 消息；原形态 system 在 messages[0] 时补回 system 头
	if (Array.isArray(recon.messages)) {
		const userMessages = (
			recon.messages as Array<Record<string, unknown>>
		).filter((m) => m.role === "user");
		if (typeof recon.system !== "string") {
			userMessages.unshift({ role: "system", content: reconSys });
		}
		recon.messages = userMessages;
	}

	// 3b) 新 pi Responses 风格：消息在 `input` 数组（system 也是其中一员）
	if (Array.isArray(recon.input)) {
		const userMessages = (
			recon.input as Array<Record<string, unknown>>
		).filter((m) => m.role === "user");
		if (typeof recon.system !== "string") {
			userMessages.unshift({ role: "system", content: reconSys });
		}
		recon.input = userMessages;
	}

	// 4) 防御：tool_choice 钉死在其他工具上时强制回 auto
	if (recon.tool_choice !== undefined && recon.tool_choice !== "auto") {
		recon.tool_choice = "auto";
	}

	return recon;
}