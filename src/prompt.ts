import { MEMORY_TAG } from "./format";

/**
 * Appended to the system prompt by `options()`. It tells the model what the
 * injected blocks are and when reaching for a memory tool beats guessing.
 */
export const MEMORY_SYSTEM_PROMPT = `## Persistent memory

You have long-term memory of this user that outlives the current session,
provided by SurrealDB Agent Memory.

- <${MEMORY_TAG}> blocks are memories retrieved for you automatically. They are
  background knowledge the user cannot see, so do not thank them for it or
  quote it back verbatim — just use it.
- Before saying you do not know something about the user, their history, their
  preferences, or earlier sessions, search memory first.
- Conversation turns are recorded for you automatically. Save a memory
  explicitly only for something durable that the turn text alone would not
  capture — a stated preference, a decision and its reasoning, a correction.
- Treat retrieved memory as evidence rather than proof. When it contradicts
  what the user just told you, the user is right, and the correction is worth
  remembering.`;

/** Builds the prompt append, naming the tools actually exposed. */
export function systemPromptFor(
	serverName: string,
	tools: readonly string[],
): string {
	if (tools.length === 0) return MEMORY_SYSTEM_PROMPT;

	const names = tools.map((tool) => `\`mcp__${serverName}__${tool}\``).join(", ");
	return `${MEMORY_SYSTEM_PROMPT}\n\nMemory tools available to you: ${names}.`;
}
