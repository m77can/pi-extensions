import test from "node:test";
import assert from "node:assert/strict";
import {
	buildReconSys,
	extractTool,
	rewriteForRecon,
} from "../extensions/pi-router-spec/core.ts";

// ── extractTool: every payload generation ─────────────────────────────────

test("extractTool: OpenAI function.name wrapper", () => {
	const tools = [
		{
			type: "function",
			function: { name: "read", description: "d", parameters: {} },
		},
		{
			type: "function",
			function: { name: "bash", description: "d", parameters: {} },
		},
	];
	const read = extractTool(tools, "read") as { function: { name: string } };
	const bash = extractTool(tools, "bash") as { function: { name: string } };
	assert.equal(read.function.name, "read");
	assert.equal(bash.function.name, "bash");
	assert.equal(extractTool(tools, "edit"), undefined);
});

test("extractTool: Anthropic name+input_schema", () => {
	const tools = [
		{ name: "read", description: "d", input_schema: { type: "object" } },
		{ name: "bash", description: "d", input_schema: { type: "object" } },
	];
	assert.equal(extractTool(tools, "read")?.name, "read");
	assert.equal(extractTool(tools, "write"), undefined);
});

test("extractTool: new Responses flat {type,name,description,parameters}", () => {
	const tools = [
		{ type: "custom", name: "read", description: "d", parameters: {} },
		{ type: "custom", name: "bash", description: "d", parameters: {} },
	];
	assert.equal(extractTool(tools, "read")?.name, "read");
	assert.equal(extractTool(tools, "bash")?.name, "bash");
});

test("extractTool: non-array / empty → undefined", () => {
	assert.equal(extractTool(undefined, "read"), undefined);
	assert.equal(extractTool([], "read"), undefined);
	assert.equal(extractTool([{ name: "read" }], "read"), undefined); // no params/schema
});

// ── rewriteForRecon: both message carriers ────────────────────────────────

const RECON_SYS = buildReconSys({} as never, []);

test("rewrite: legacy messages carrier keeps system header", () => {
	const payload = {
		model: "m",
		tools: ["t1", "t2"],
		system: undefined,
		messages: [
			{ role: "system", content: "original system" },
			{ role: "user", content: "u1" },
			{ role: "user", content: "u2" },
		],
	};
	const out = rewriteForRecon(payload as never, RECON_SYS, [{ name: "read" }]);
	const messages = out.messages as Array<Record<string, unknown>>;
	assert.deepEqual(
		messages.map((m) => m.role),
		["system", "user", "user"],
	);
	assert.equal(messages[0]!.content, RECON_SYS);
	assert.equal((out.tools as unknown[]).length, 1);
});

test("rewrite: top-level system field is replaced, no dup header", () => {
	const payload = {
		system: "full agent prompt",
		messages: [{ role: "user", content: "u1" }],
		tools: ["a", "b"],
	};
	const out = rewriteForRecon(payload as never, RECON_SYS, [{ name: "read" }]);
	assert.equal(out.system, RECON_SYS);
	const messages = out.messages as Array<Record<string, unknown>>;
	assert.deepEqual(messages.map((m) => m.role), ["user"]);
});

test("rewrite: new Responses input carrier gets stripped+system head", () => {
	const payload = {
		model: "m",
		input: [
			{ role: "system", content: "original" },
			{ role: "user", content: "u1" },
			{ role: "user", content: "u2" },
		],
		tools: [{ name: "read" }, { name: "edit" }],
		reasoning: { effort: "xhigh" },
	};
	const out = rewriteForRecon(payload as never, RECON_SYS, [
		{ name: "read" },
		{ name: "bash" },
	]);
	const input = out.input as Array<Record<string, unknown>>;
	assert.deepEqual(input.map((m) => m.role), ["system", "user", "user"]);
	assert.equal(input[0]!.content, RECON_SYS);
	assert.equal((out.tools as unknown[]).length, 2);
	// untouched fields survive
	assert.deepEqual(out.reasoning, { effort: "xhigh" });
});

test("rewrite: pinned tool_choice is reset to auto", () => {
	const payload = { tool_choice: "edit", messages: [{ role: "user" }], tools: [] };
	const out = rewriteForRecon(payload as never, RECON_SYS, []);
	assert.equal(out.tool_choice, "auto");
});