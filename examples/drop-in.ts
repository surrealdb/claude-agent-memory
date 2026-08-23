/**
 * The one-liner: an agent that remembers, with no other wiring.
 *
 *   bun run examples/drop-in.ts "I moved to Lisbon last month"
 *   bun run examples/drop-in.ts "Where do I live?"
 *
 * Run it twice with those two prompts. The second run answers from what the
 * first one stored, in a different process, with nothing persisted locally.
 *
 * Needs SPECTRON_ENDPOINT, SPECTRON_API_KEY, and SPECTRON_CONTEXT.
 */
import { createAgentMemory } from "../src/index";

const memory = createAgentMemory();

const prompt = process.argv[2] ?? "What do you know about me?";

for await (const message of memory.query({ prompt })) {
	if (message.type === "assistant") {
		for (const block of message.message.content) {
			if (block.type === "text") process.stdout.write(block.text);
		}
	}

	if (message.type === "result") {
		process.stdout.write("\n");
	}
}
