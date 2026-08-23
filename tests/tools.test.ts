import { describe, expect, test } from "bun:test";
import { ConnectionError } from "@surrealdb/spectron";
import { resolveConfig } from "../src/config";
import { buildTools, toolNames } from "../src/tools";
import type { AgentMemoryConfig, MemoryToolName } from "../src/types";
import { MockSpectron } from "./mocks/spectron";

/** The parts of an MCP tool result these tests read. */
interface CallToolResult {
	content: { type: string; text: string }[];
	isError?: boolean;
}

interface ToolDef {
	name: string;
	description: string;
	handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
}

function tool(definitions: ToolDef[], name: MemoryToolName): ToolDef {
	const found = definitions.find((definition) => definition.name === name);
	if (!found) throw new Error(`tool ${name} is not registered`);
	return found;
}

/** The tool definitions a given config would register. */
function definitionsFor(config: Partial<AgentMemoryConfig> = {}): {
	spectron: MockSpectron;
	tools: ToolDef[];
} {
	const spectron = new MockSpectron();
	const tools = buildTools(
		resolveConfig({ client: spectron.asClient(), ...config }),
	) as unknown as ToolDef[];

	return { spectron, tools };
}

const textOf = (result: CallToolResult) =>
	(result.content as { type: string; text: string }[])
		.map((block) => block.text)
		.join("\n");

describe("registration", () => {
	test("exposes the default set, with the destructive tool held back", async () => {
		const { tools } = definitionsFor();
		const names = tools.map((definition) => definition.name);

		expect(names).toEqual([
			"recall",
			"context",
			"remember",
			"reflect",
			"profile",
			"inspect",
		]);
	});

	test("exposes forget only when asked", async () => {
		const { tools } = definitionsFor({ tools: { include: ["forget"] } });

		expect(tools.map((definition) => definition.name)).toContain("forget");
	});

	test("qualifies tool names with the server name", () => {
		const resolved = resolveConfig({
			client: new MockSpectron().asClient(),
			serverName: "brain",
			tools: ["recall"],
		});

		expect(toolNames(resolved)).toEqual(["mcp__brain__recall"]);
	});

	test("describes the destructive tool as destructive", async () => {
		const { tools } = definitionsFor({ tools: { include: ["forget"] } });

		expect(tool(tools, "forget").description).toContain("destructive");
		expect(tool(tools, "forget").description).toContain("explicitly");
	});
});

describe("handlers", () => {
	test("recall renders hits and forwards k and the lens", async () => {
		const { spectron, tools } = definitionsFor({ lens: "user/tobie" });

		const result = await tool(tools, "recall").handler(
			{ query: "where do I live", k: 2 },
			undefined,
		);

		expect(textOf(result)).toContain("- Prefers dark mode");
		expect(spectron.callsFor("recall")[0]?.args[1]).toMatchObject({
			k: 2,
			lens: "user/tobie",
		});
	});

	test("recall falls back to the configured k", async () => {
		const { spectron, tools } = definitionsFor({ k: 5 });

		await tool(tools, "recall").handler({ query: "x" }, undefined);

		expect(spectron.callsFor("recall")[0]?.args[1]).toMatchObject({ k: 5 });
	});

	test("recall says so plainly when nothing matches", async () => {
		const { spectron, tools } = definitionsFor();
		spectron.hits = [];

		const result = await tool(tools, "recall").handler(
			{ query: "unicorns" },
			undefined,
		);

		expect(textOf(result)).toContain("No memories found");
		expect(result.isError).toBeUndefined();
	});

	test("context returns the server-formatted briefing", async () => {
		const { tools } = definitionsFor();

		const result = await tool(tools, "context").handler(
			{ query: "preferences" },
			undefined,
		);

		expect(textOf(result)).toContain("prefers dark mode");
	});

	test("remember writes with the configured scopes and labels", async () => {
		const { spectron, tools } = definitionsFor({
			scopes: "team/eng",
			labels: ["app=demo"],
		});

		const result = await tool(tools, "remember").handler(
			{ text: "Moved to Lisbon" },
			undefined,
		);

		expect(textOf(result)).toContain("Saved");
		expect(spectron.callsFor("remember")[0]?.args).toEqual([
			"Moved to Lisbon",
			{ infer: "full", scopes: "team/eng", labels: ["app=demo"] },
		]);
	});

	test("reflect includes the evidence behind the insight", async () => {
		const { tools } = definitionsFor();

		const result = await tool(tools, "reflect").handler(
			{ query: "what changed" },
			undefined,
		);

		expect(textOf(result)).toContain("shifted to Lisbon");
		expect(textOf(result)).toContain("Evidence:");
	});

	test("profile renders the stored slices", async () => {
		const { tools } = definitionsFor();

		const result = await tool(tools, "profile").handler({}, undefined);

		expect(textOf(result)).toContain("name: Tobie");
	});

	test("forget reports how much it deleted", async () => {
		const { spectron, tools } = definitionsFor({
			tools: { include: ["forget"] },
		});

		const result = await tool(tools, "forget").handler(
			{ query: "old notes", purge: true },
			undefined,
		);

		expect(textOf(result)).toContain("Deleted 3");
		expect(spectron.callsFor("forget")[0]?.args[1]).toMatchObject({ purge: true });
	});

	test("a failure becomes a tool error, never a thrown turn", async () => {
		const { spectron, tools } = definitionsFor();
		spectron.failWith("recall", new ConnectionError({ status: 0, title: "down" }));

		const result = await tool(tools, "recall").handler({ query: "x" }, undefined);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("unavailable");
	});

	test("a failed write says nothing was saved", async () => {
		const { spectron, tools } = definitionsFor();
		spectron.failWith("remember", new Error("down"));

		const result = await tool(tools, "remember").handler(
			{ text: "x" },
			undefined,
		);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("nothing was saved");
	});

	test("tools keep answering even when the caller chose to fail closed", async () => {
		const { spectron, tools } = definitionsFor({ failOpen: false });
		spectron.failWith("recall", new Error("down"));

		const result = await tool(tools, "recall").handler({ query: "x" }, undefined);

		expect(result.isError).toBe(true);
	});
});
