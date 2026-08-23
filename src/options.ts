import type {
	HookCallbackMatcher,
	HookEvent,
	McpSdkServerConfigWithInstance,
	Options,
} from "@anthropic-ai/claude-agent-sdk";
import { isMemoryMatcher } from "./hooks";

export interface MergeInput {
	base: Options | undefined;
	serverName: string;
	server: McpSdkServerConfigWithInstance | undefined;
	toolNames: string[];
	hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
	systemPromptAppend: string | undefined;
}

/**
 * Merges memory wiring into query options without mutating the caller's object.
 * Applying it twice is a no-op, so passing `options()` output through
 * `memory.query()` does not double up.
 */
export function mergeOptions({
	base,
	serverName,
	server,
	toolNames,
	hooks,
	systemPromptAppend,
}: MergeInput): Options {
	const merged: Options = { ...base };

	if (server) {
		const existing = base?.mcpServers?.[serverName];
		if (existing && existing !== server) {
			throw new Error(
				`@surrealdb/claude-agent-memory: options.mcpServers already has a ` +
					`server named "${serverName}". Pass a different serverName to ` +
					"createAgentMemory() to avoid the collision.",
			);
		}

		merged.mcpServers = { ...base?.mcpServers, [serverName]: server };
		merged.allowedTools = union(base?.allowedTools, toolNames);
	}

	merged.hooks = mergeHooks(base?.hooks, hooks);

	if (systemPromptAppend !== undefined) {
		merged.systemPrompt = appendSystemPrompt(base?.systemPrompt, systemPromptAppend);
	}

	return merged;
}

function union(base: string[] | undefined, added: string[]): string[] {
	return [...new Set([...(base ?? []), ...added])];
}

/**
 * Merges hooks, replacing any memory hooks a previous merge left behind rather
 * than stacking a second copy on top.
 *
 * Replacing rather than skipping is what lets the same options be merged twice
 * without doubling the injection, while still allowing a per-call override to
 * take effect over hooks that are already there.
 */
function mergeHooks(
	base: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined,
	added: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	const merged: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
	const events = new Set<HookEvent>([
		...(Object.keys(base ?? {}) as HookEvent[]),
		...(Object.keys(added) as HookEvent[]),
	]);

	for (const event of events) {
		const theirs = (base?.[event] ?? []).filter(
			(matcher) => !isMemoryMatcher(matcher),
		);

		// The caller's hooks run first: theirs may block a turn, and there is no
		// point spending a memory round trip on a turn that will not happen.
		const combined = [...theirs, ...(added[event] ?? [])];
		if (combined.length > 0) merged[event] = combined;
	}

	return merged;
}

/**
 * Adds our text to whichever of the `systemPrompt` shapes the caller used,
 * preserving their choice: a preset keeps its preset and grows its `append`, a
 * string or array is extended, and an absent prompt is only ever added to —
 * nothing the caller wrote is replaced.
 */
function appendSystemPrompt(
	base: Options["systemPrompt"],
	append: string,
): Options["systemPrompt"] {
	if (base === undefined) return append;

	if (typeof base === "string") {
		return base.includes(append) ? base : `${base}\n\n${append}`;
	}

	if (Array.isArray(base)) {
		return base.some((block) => block.includes(append))
			? base
			: [...base, append];
	}

	if (base.append?.includes(append)) return base;

	return {
		...base,
		append: base.append ? `${base.append}\n\n${append}` : append,
	};
}
