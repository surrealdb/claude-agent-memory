/**
 * One process, many users, no memory bleeding between them.
 *
 *   bun run examples/multi-tenant.ts
 *
 * Two things keep users apart. `onBehalfOf` makes every request run as that
 * principal, so the service enforces the boundary rather than trusting us; the
 * scope and lens then narrow reads and writes to that user's region.
 */
import { Spectron, createAgentMemory } from "../src/index";

const base = new Spectron({
	endpoint: process.env.SPECTRON_ENDPOINT!,
	apiKey: process.env.SPECTRON_API_KEY!,
	context: process.env.SPECTRON_CONTEXT!,
});

/** Per-request memory for one user. Cheap to build; build it per request. */
function memoryFor(userId: string) {
	return createAgentMemory({
		client: base.onBehalfOf(`principal:${userId}`),
		scopes: `user/${userId}`,
		lens: `user/${userId}`,
		labels: [`tenant=${userId}`],

		// Remember which memory session each user's conversation used, so a later
		// request can resume it by passing `sessionId`.
		onSession: ({ claudeSessionId, memorySessionId }) => {
			console.log(`[${userId}] ${claudeSessionId} → ${memorySessionId}`);
		},
	});
}

async function ask(userId: string, prompt: string): Promise<void> {
	const memory = memoryFor(userId);

	for await (const message of memory.query({ prompt })) {
		if (message.type === "result" && message.subtype === "success") {
			console.log(`[${userId}] ${message.result}`);
		}
	}
}

await ask("alex", "I prefer Rust for systems work. Remember that.");
await ask("sam", "What language do I prefer?");
// Sam's agent has no way to see Alex's preference: different principal,
// different scope, different lens.
