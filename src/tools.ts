import {
	createSdkMcpServer,
	tool,
	type McpSdkServerConfigWithInstance,
	type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ResolvedConfig } from "./config";
import { formatHits, formatProfile } from "./format";
import { guard, isAvailable } from "./guard";
import type { MemoryToolName } from "./types";

const text = (body: string) => ({
	content: [{ type: "text" as const, text: body }],
});

const failure = (body: string) => ({
	content: [{ type: "text" as const, text: body }],
	isError: true,
});

const K = z
	.number()
	.int()
	.min(1)
	.max(50)
	.optional()
	.describe("Maximum results to return. Defaults to a sensible small number.");

/**
 * Builds the memory tools. A handler never throws: a memory outage should read
 * to the model as one tool that could not answer, not as a broken turn.
 */
export function buildTools(config: ResolvedConfig): SdkMcpToolDefinition<any>[] {
	const { client } = config;
	const run = <T>(op: Parameters<typeof guard>[1], fn: () => Promise<T>) =>
		guard({ ...config, failOpen: true }, op, fn);

	const defs: Record<MemoryToolName, () => SdkMcpToolDefinition<any>> = {
		recall: () =>
			tool(
				"recall",
				"Search the user's persistent long-term memory for specific facts, " +
					"preferences, decisions, people, or past events. Use this before " +
					"telling the user you do not know something about them, their " +
					"history, or an earlier session.",
				{
					query: z
						.string()
						.min(1)
						.describe(
							"What to look for, as a natural-language question or topic.",
						),
					k: K,
				},
				async ({ query, k }) => {
					const result = await run("recall", () =>
						client.recall(query, {
							k: k ?? config.k,
							...(config.lens === undefined ? {} : { lens: config.lens }),
						}),
					);
					if (!isAvailable(result)) return failure("Memory is unavailable.");
					const body = formatHits(result.hits);
					return text(body || `No memories found for "${query}".`);
				},
			),

		context: () =>
			tool(
				"context",
				"Get a synthesized briefing from long-term memory about a topic — " +
					"deduplicated and written as prose. Prefer this over recall when " +
					"you want an overview rather than individual facts.",
				{
					query: z.string().min(1).describe("The topic to be briefed on."),
					k: K,
				},
				async ({ query, k }) => {
					const result = await run("context", () =>
						client.context(query, {
							k: k ?? config.k,
							...(config.lens === undefined ? {} : { lens: config.lens }),
						}),
					);
					if (!isAvailable(result)) return failure("Memory is unavailable.");
					return text(
						result.context.trim() || `No memory context for "${query}".`,
					);
				},
			),

		remember: () =>
			tool(
				"remember",
				"Save something durable to long-term memory so later sessions know " +
					"it: a stated preference, a decision and why it was made, a " +
					"correction, a fact about the user or their work. Conversation " +
					"turns are already recorded automatically, so do not use this to " +
					"restate what was just said, and do not use it for transient " +
					"task state.",
				{
					text: z
						.string()
						.min(1)
						.describe(
							"The thing to remember, written as a standalone statement " +
								"that will still make sense with no conversation around it.",
						),
				},
				async ({ text: fact }) => {
					const result = await run("remember", () =>
						client.remember(fact, {
							infer: "full",
							...(config.scopes === undefined ? {} : { scopes: config.scopes }),
							...(config.labels.length === 0
								? {}
								: { labels: config.labels }),
						}),
					);
					if (!isAvailable(result))
						return failure("Memory is unavailable; nothing was saved.");
					return text("Saved to long-term memory.");
				},
			),

		reflect: () =>
			tool(
				"reflect",
				"Ask the memory system to reason across everything it knows about a " +
					"topic and return an insight, rather than retrieving stored text. " +
					"Useful for questions like what changed, what patterns exist, or " +
					"what the user seems to want.",
				{
					query: z.string().min(1).describe("The question to reflect on."),
					persist: z
						.boolean()
						.optional()
						.describe("Save the resulting insight back to memory."),
				},
				async ({ query, persist }) => {
					const result = await run("reflect", () =>
						client.reflect(query, { persist: persist ?? false }),
					);
					if (!isAvailable(result)) return failure("Memory is unavailable.");
					const evidence = result.evidence.length
						? `\n\nEvidence:\n${result.evidence.map((line) => `- ${line}`).join("\n")}`
						: "";
					return text(`${result.reflection}${evidence}`);
				},
			),

		profile: () =>
			tool(
				"profile",
				"Get what memory holds about who the user is: identity, standing " +
					"preferences, and instructions they have given.",
				{},
				async () => {
					const result = await run("profile", () => client.profile());
					if (!isAvailable(result)) return failure("Memory is unavailable.");
					return text(formatProfile(result) || "No profile recorded yet.");
				},
			),

		inspect: () =>
			tool(
				"inspect",
				"Inspect one memory or entity in full, including where it came from " +
					"and how it changed over time. Takes a reference such as an id " +
					"returned by recall, or an entity like `person:tobie`.",
				{
					ref: z
						.string()
						.min(1)
						.describe("The memory, entity, or trace reference to inspect."),
				},
				async ({ ref }) => {
					const result = await run("inspect", () => client.inspect(ref));
					if (!isAvailable(result))
						return failure(`Could not inspect "${ref}".`);
					return text(JSON.stringify(result, null, 2));
				},
			),

		forget: () =>
			tool(
				"forget",
				"Delete memories matching a query. This is destructive and takes " +
					"effect immediately. Use it only when the user has explicitly " +
					"asked to forget something, and confirm with them what will be " +
					"removed before calling it. Setting purge also erases the " +
					"history behind the memory, which cannot be undone.",
				{
					query: z
						.string()
						.min(1)
						.describe("Describes the memories to delete."),
					purge: z
						.boolean()
						.optional()
						.describe(
							"Also erase superseded history. Irreversible; leave unset " +
								"unless the user asked for a permanent erasure.",
						),
				},
				async ({ query, purge }) => {
					const result = await run("forget", () =>
						client.forget(query, { purge: purge ?? false }),
					);
					if (!isAvailable(result))
						return failure("Memory is unavailable; nothing was deleted.");
					return text(`Deleted ${result.deleted} memories.`);
				},
			),
	};

	return config.tools.map((name) => defs[name]());
}

/** The in-process MCP server carrying the selected memory tools. */
export function buildMcpServer(
	config: ResolvedConfig,
): McpSdkServerConfigWithInstance {
	return createSdkMcpServer({
		name: config.serverName,
		version: "0.1.0",
		instructions:
			"SurrealDB Agent Memory: persistent, cross-session memory of this " +
			"user. Search it before assuming something is unknown.",
		tools: buildTools(config),
	});
}

/** Fully-qualified names for the selected tools, for `allowedTools`. */
export function toolNames(config: ResolvedConfig): string[] {
	return config.tools.map((name) => `mcp__${config.serverName}__${name}`);
}
