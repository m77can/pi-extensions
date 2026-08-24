import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getConfig, subscribeConfig } from "../../shared/pi-tui-store.js";
import {
	buildReconSys,
	extractTool,
	rewriteForRecon,
} from "./core.js";

export { buildReconSys, extractTool, rewriteForRecon } from "./core.js";

/**
 * pi-router-spec —— 首轮 Recon 侦察（read + bash）→ 全量续跑
 *
 * 在 provider payload 层重构首轮请求：
 *   首轮（分支无 assistant 消息）→ [极简 RECON_SYS, 仅 read/bash 工具, 仅 user 消息]
 *   think1 落地后（分支已有 assistant 消息）→ 完全不干预, pi 原始 payload 原样发出
 *
 * 判定完全由会话分支内容推导, 零状态机、零持久化；
 * RECON_SYS 极简：只写一句 "You are a helpful software engineer assistant.", 其他一律不加；
 * 工具照旧：第一轮只带 read + bash（bash 限定只读侦察命令）, 写工具不参与 recon 阶段。
 */

// ---- §4.6 模型门控常量 ----
// 每条目为正则模式，匹配时忽略大小写，作用于当前模型 id 的 basename。
// 默认是子串搜索匹配："deepseek-v4-flash" 可匹配 "deepseek-v4-flash-0731"；
// 需要精确匹配时可写 "^deepseek-v4-flash$" 或 "^deepseek-v4-flash(-\\d+)?$"。
// 空数组 = 对所有模型生效（不门控）
const TARGET_MODEL_IDS: string[] = [
	"deepseek-v4-pro-0813",
	"deepseek-v4-pro",
	"deepseek-v4-flash",
];
const MODEL_GATE_ENABLED = TARGET_MODEL_IDS.length > 0;
const TARGET_MODEL_RES: RegExp[] = TARGET_MODEL_IDS.map(
	(pattern) => new RegExp(pattern, "i"),
);

// ---- §4.2 判定 ----
function hasAssistantMessage(ctx: ExtensionContext): boolean {
	return ctx.sessionManager
		.getBranch()
		.some(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
}

// ---- §4.6 当前模型 id 提取 ----
function currentModelId(ctx: ExtensionContext): string | undefined {
	const model = ctx.model;
	return model ? model.id.toLowerCase().split("/").at(-1) : undefined;
}

export default function piRouterSpec(pi: ExtensionAPI): void {
	// §4.5 内存标志（tool_call 双保险用）
	let reconActive = false;

	const enabled = () => {
		const c = getConfig();
		return c.enabled && c.modules.routerSpec;
	};

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled()) return undefined;

		const payload = event.payload;
		const body = (
			typeof payload === "object" && payload !== null ? payload : {}
		) as Record<string, unknown>;

		// 判定 1：分支已有 assistant 消息（think1 已落地 / /resume / 第二轮提问）→ 不重构, 清标志
		if (hasAssistantMessage(ctx)) {
			reconActive = false;
			return undefined;
		}

		// 判定 2：tools 不是非空数组 → 不重构（非 agent 请求, 如标题生成）, 清标志
		if (!Array.isArray(body.tools) || body.tools.length === 0) {
			reconActive = false;
			return undefined;
		}

		// 判定 3：模型门控开启且当前模型 id 不匹配任一目标正则 → 不重构, 清标志
		if (MODEL_GATE_ENABLED) {
			const id = currentModelId(ctx);
			if (id === undefined || !TARGET_MODEL_RES.some((re) => re.test(id))) {
				reconActive = false;
				return undefined;
			}
		}

		// 判定 4：tools 里有 read（pi 生成的内置条目）才重构；没有 read 则不重构：
		// pi 都没给 read, recon 阶段也不该带任何工具（绝不自造 pi 执行不了的工具）
		const readTool = extractTool(body.tools, "read");
		if (!readTool) {
			reconActive = false;
			return undefined;
		}
		// bash 是加分项：pi 提供了就一并带上（recon 阶段可用 ls/grep/find 等只读侦察）；
		// pi 没提供 bash 则退回仅 read, 照样重构
		const bashTool = extractTool(body.tools, "bash");
		const reconTools = bashTool ? [readTool, bashTool] : [readTool];
		const reconToolNames = bashTool ? ["read", "bash"] : ["read"];

		// 判定 5：以上均通过 → 重构
		const reconSys = buildReconSys(ctx, reconToolNames);
		const rewritten = rewriteForRecon(body, reconSys, reconTools);
		if (rewritten === body) {
			reconActive = false;
			return undefined;
		}
		reconActive = true;
		console.log("[pi-router-spec] recon request", {
			model: currentModelId(ctx) ?? "unknown",
			toolCount: body.tools.length,
			reconTools: reconToolNames,
			// roles from whichever message carrier this payload shape uses
			messageRoles: Array.isArray(body.input)
				? (body.input as Array<Record<string, unknown>>).map((m) => m.role)
				: Array.isArray(body.messages)
					? (body.messages as Array<Record<string, unknown>>).map((m) => m.role)
					: undefined,
		});
		return rewritten;
	});

	// §4.5 tool_call 双保险：reconActive 期间只放行 read / bash（payload 层已过滤, 正常不会触发）
	pi.on("tool_call", async (event, _ctx) => {
		if (reconActive && event.toolName !== "read" && event.toolName !== "bash") {
			return { block: true, reason: "recon phase: only read/bash allowed" };
		}
		return undefined;
	});

	subscribeConfig(() => {
		// Re-read config on demand; disabling routerSpec anywhere clears the
		// in-flight recon flag so no stale gate survives the toggle.
		if (!enabled()) reconActive = false;
	});

	// §4.5 兜底清除标志, 防止泄漏到下一轮
	pi.on("turn_end", () => {
		reconActive = false;
	});
	pi.on("agent_end", () => {
		reconActive = false;
	});
}
