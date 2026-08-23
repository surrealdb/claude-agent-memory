import { describe, expect, test } from "bun:test";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { createAgentMemory } from "../src/memory";
import { MockSpectron } from "./mocks/spectron";

const memory = (overrides = {}) =>
	createAgentMemory({ client: new MockSpectron().asClient(), ...overrides });

const noop: HookCallback = async () => ({ continue: true });

describe("options()", () => {
	test("registers the MCP server and allows its tools", () => {
		const options = memory().options();

		expect(options.mcpServers).toHaveProperty("spectron");
		expect(options.allowedTools).toContain("mcp__spectron__recall");
		expect(options.allowedTools).not.toContain("mcp__spectron__forget");
	});

	test("honours a custom server name in tool names", () => {
		const options = memory({ serverName: "brain" }).options();

		expect(options.mcpServers).toHaveProperty("brain");
		expect(options.allowedTools).toContain("mcp__brain__recall");
	});

	test("does not mutate the caller's options", () => {
		const base: Options = { model: "claude-sonnet-4-5", allowedTools: ["Read"] };
		const result = memory().options(base);

		expect(base.mcpServers).toBeUndefined();
		expect(base.allowedTools).toEqual(["Read"]);
		expect(result.model).toBe("claude-sonnet-4-5");
		expect(result.allowedTools).toContain("Read");
	});

	test("keeps the caller's other MCP servers", () => {
		const base = {
			mcpServers: { weather: { type: "http", url: "https://x" } },
		} as unknown as Options;

		const result = memory().options(base);

		expect(result.mcpServers).toHaveProperty("weather");
		expect(result.mcpServers).toHaveProperty("spectron");
	});

	test("refuses to silently overwrite a name collision", () => {
		const base = {
			mcpServers: { spectron: { type: "http", url: "https://x" } },
		} as unknown as Options;

		expect(() => memory().options(base)).toThrow(/serverName/);
	});

	test("omits the server entirely when no tools are enabled", () => {
		const options = memory({ tools: false }).options();

		expect(options.mcpServers).toBeUndefined();
		expect(options.allowedTools).toBeUndefined();
	});

	test("asking for the server with no tools enabled explains why", () => {
		const instance = memory({ tools: false });

		expect(() => instance.mcpServer()).toThrow(/tools: false/);
		expect(instance.toolNames()).toEqual([]);
	});

	test("applies cleanly twice", () => {
		const instance = memory();
		const once = instance.options({ model: "m" });
		const twice = instance.options(once);

		expect(Object.keys(twice.mcpServers ?? {})).toEqual(["spectron"]);
		expect(twice.allowedTools).toEqual(once.allowedTools);
		expect(twice.hooks?.UserPromptSubmit).toHaveLength(1);
		expect(twice.systemPrompt).toBe(once.systemPrompt);
	});

	test("runs the caller's hooks before ours", () => {
		const base: Options = { hooks: { UserPromptSubmit: [{ hooks: [noop] }] } };
		const result = memory().options(base);

		expect(result.hooks?.UserPromptSubmit).toHaveLength(2);
		expect(result.hooks?.UserPromptSubmit?.[0]?.hooks[0]).toBe(noop);
		expect(base.hooks?.UserPromptSubmit).toHaveLength(1);
	});

	test("keeps hook events the caller registered that we do not use", () => {
		const base: Options = { hooks: { PreToolUse: [{ hooks: [noop] }] } };
		const result = memory().options(base);

		expect(result.hooks?.PreToolUse).toHaveLength(1);
		expect(result.hooks?.UserPromptSubmit).toHaveLength(1);
	});

	test("re-merging keeps the caller's hooks alongside ours", () => {
		const instance = memory();
		const base: Options = { hooks: { UserPromptSubmit: [{ hooks: [noop] }] } };

		const twice = instance.options(instance.options(base));

		expect(twice.hooks?.UserPromptSubmit).toHaveLength(2);
		expect(twice.hooks?.UserPromptSubmit?.[0]?.hooks[0]).toBe(noop);
	});

	test("hooks() hands out a copy, not the instance's own record", () => {
		const instance = memory();

		const handed = instance.hooks();
		handed.UserPromptSubmit = [];
		delete handed.SessionStart;

		expect(instance.options().hooks?.UserPromptSubmit).toHaveLength(1);
		expect(instance.options().hooks?.SessionStart).toHaveLength(1);
	});
});

describe("system prompt", () => {
	test("is set when the caller has none", () => {
		expect(memory().options().systemPrompt).toContain("Persistent memory");
	});

	test("extends a string prompt instead of replacing it", () => {
		const result = memory().options({ systemPrompt: "You are terse." });

		expect(result.systemPrompt).toStartWith("You are terse.");
		expect(result.systemPrompt).toContain("Persistent memory");
	});

	test("appends to an array prompt as a new block", () => {
		const result = memory().options({ systemPrompt: ["a", "b"] });

		expect(Array.isArray(result.systemPrompt)).toBe(true);
		expect(result.systemPrompt).toHaveLength(3);
	});

	test("preserves a preset and grows its append", () => {
		const result = memory().options({
			systemPrompt: { type: "preset", preset: "claude_code", append: "House style." },
		});

		expect(result.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
		const append = (result.systemPrompt as { append: string }).append;
		expect(append).toStartWith("House style.");
		expect(append).toContain("Persistent memory");
	});

	test("names the tools that are actually exposed", () => {
		const prompt = memory({ tools: ["recall"] }).options().systemPrompt as string;

		expect(prompt).toContain("mcp__spectron__recall");
		expect(prompt).not.toContain("mcp__spectron__forget");
	});

	test("can be turned off without losing the rest of the wiring", () => {
		const options = memory({ systemPrompt: false }).options();

		expect(options.systemPrompt).toBeUndefined();
		expect(options.mcpServers).toHaveProperty("spectron");
	});
});
