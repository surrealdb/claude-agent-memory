/**
 * Keeping your own `query()` call and merging memory into its options.
 *
 *   bun run examples/composable.ts
 *
 * `memory.options()` adds the memory tools, hooks, and system-prompt text to
 * whatever options you already had. Your model, turn limit, hooks, and other
 * MCP servers survive untouched.
 */
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { createAgentMemory } from "../src/index";

const memory = createAgentMemory({
	// Scope everything this process writes and reads to one user.
	scopes: "user/tobie",
	lens: "user/tobie",
});

const auditPrompt: HookCallback = async (input) => {
	console.error(`[audit] prompt in session ${input.session_id}`);
	return { continue: true };
};

for await (const message of query({
	prompt: "What was I working on, and what should I pick up next?",
	options: memory.options({
		model: "claude-sonnet-4-5",
		maxTurns: 10,
		systemPrompt: { type: "preset", preset: "claude_code", append: "Be concise." },
		hooks: { UserPromptSubmit: [{ hooks: [auditPrompt] }] },
	}),
})) {
	if (message.type === "result" && message.subtype === "success") {
		console.log(message.result);
	}
}

// Turns are only captured by `memory.query()`. On this path the model still has
// the memory tools and injected context, so anything worth keeping can be saved
// deliberately — either by the model calling `remember`, or directly:
await memory.client.remember("Reviewed the composable example", {
	scopes: "user/tobie",
});
