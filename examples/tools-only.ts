/**
 * Memory the model reaches for itself, with nothing injected automatically.
 *
 *   bun run examples/tools-only.ts
 *
 * Injection is off, so no memory call happens unless the model decides to make
 * one. Useful when you want the retrieval to be visible in the transcript, or
 * when you are paying close attention to tokens per turn.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createAgentMemory } from "../src/index";

const memory = createAgentMemory({
	injectHistory: false,
	injectProfile: false,
	// Let the model delete memories too — off by default because it is
	// destructive.
	tools: { include: ["forget"] },
});

console.log("tools offered to the model:", memory.toolNames());

for await (const message of query({
	prompt: "Look up what you know about my project, then summarise it.",
	options: {
		mcpServers: { spectron: memory.mcpServer() },
		allowedTools: memory.toolNames(),
		systemPrompt: memory.systemPromptAppend(),
	},
})) {
	if (message.type === "assistant") {
		for (const block of message.message.content) {
			if (block.type === "tool_use") console.log(`→ ${block.name}`);
			if (block.type === "text") console.log(block.text);
		}
	}
}
