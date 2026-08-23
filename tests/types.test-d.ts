/**
 * Compile-time assertions, checked by `bun run typecheck` rather than at
 * runtime. They exist to catch drift in the Agent SDK's own types: if `Options`
 * or `Query` change shape under us, this file stops compiling.
 */
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAgentMemory } from "../src/index";
import type { AgentMemory, Scope } from "../src/index";

declare const options: Options;

const memory: AgentMemory = createAgentMemory({ endpoint: "x", apiKey: "y", context: "z" });

// `options()` produces something the SDK's own `query()` would accept.
const merged: Options = memory.options(options);
const fromNothing: Options = memory.options();

// The wrapper preserves the full Query surface, control methods included.
const query: Query = memory.query({ prompt: "hi" });
const interrupted: Promise<unknown> = query.interrupt();
const iterated: AsyncGenerator<unknown, void> = query[Symbol.asyncIterator]();

// Streaming input is accepted as well as a plain string.
declare const stream: AsyncIterable<SDKUserMessage>;
const streamed: Query = memory.query({ prompt: stream, options: merged });

// Scopes accept every documented DNF shape.
const single: Scope = "team/eng";
const anyOf: Scope = ["team/eng", "org/acme"];
const allOf: Scope = [["team/eng", "org/acme"]];

// A pinned session is a string or an explicit opt-out, never a factory.
createAgentMemory({ client: memory.client, sessionId: "session:1" });
createAgentMemory({ client: memory.client, sessionId: false });

// @ts-expect-error retrieval only accepts the two documented modes
createAgentMemory({ client: memory.client, retrieval: "semantic" });

// @ts-expect-error unknown tool names are rejected
createAgentMemory({ client: memory.client, tools: ["recall", "teleport"] });

// @ts-expect-error k must be a number
createAgentMemory({ client: memory.client, k: "eight" });

export type Checked = [
	typeof merged,
	typeof fromNothing,
	typeof query,
	typeof interrupted,
	typeof iterated,
	typeof streamed,
	typeof single,
	typeof anyOf,
	typeof allOf,
];
