import type {
	HookCallback,
	HookCallbackMatcher,
	HookEvent,
	HookJSONOutput,
	SessionStartHookInput,
	UserPromptSubmitHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import type { ResolvedConfig } from "./config";
import { formatHits, formatProfile, memoryBlock } from "./format";
import { guard, isAvailable } from "./guard";
import type { SessionBinder } from "./sessions";

/** Marks the individual matchers we add, so a merge can recognise its own. */
export const MEMORY_HOOKS = Symbol.for("@surrealdb/claude-agent-memory.hooks");

/** Tags a matcher as ours. */
function ours(matcher: HookCallbackMatcher): HookCallbackMatcher {
	Object.defineProperty(matcher, MEMORY_HOOKS, {
		value: true,
		enumerable: false,
	});
	return matcher;
}

const CONTINUE: HookJSONOutput = { continue: true };

function inject(
	hookEventName: "UserPromptSubmit" | "SessionStart",
	additionalContext: string | undefined,
): HookJSONOutput {
	if (additionalContext === undefined) return CONTINUE;
	return { continue: true, hookSpecificOutput: { hookEventName, additionalContext } };
}

export interface HookDeps {
	config: ResolvedConfig;
	binder: SessionBinder;
	/** Awaits in-flight writes, so nothing buffered is lost. */
	flush: () => Promise<void>;
}

/**
 * Builds the hooks that put memory in front of the model.
 *
 * Both injecting hooks sit on the critical path of a turn, so each one races a
 * deadline and contributes nothing if it loses — a slow memory service should
 * cost latency once, never the turn.
 */
export function buildHooks({
	config,
	binder,
	flush,
}: HookDeps): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
	const budget = { timeoutMs: config.injectTimeoutMs };

	if (config.injectHistory) {
		const onPrompt: HookCallback = async (input) => {
			const { prompt } = input as UserPromptSubmitHookInput;
			if (!prompt || prompt.trim().length === 0) return CONTINUE;

			const body = await (config.retrieval === "recall"
				? recallBody(config, prompt)
				: contextBody(config, prompt));

			return inject("UserPromptSubmit", memoryBlock(body ?? "", config.maxInjectChars));
		};

		hooks.UserPromptSubmit = [ours({ hooks: [onPrompt] })];
	}

	if (config.injectProfile) {
		const onSessionStart: HookCallback = async (input) => {
			const { source } = input as SessionStartHookInput;

			// A resumed or forked session already carries the profile in its
			// transcript; re-injecting it would just duplicate context.
			if (source === "resume" || source === "fork") return CONTINUE;

			const profile = await guard(
				config,
				"profile",
				() => config.client.profile(),
				budget,
			);
			if (!isAvailable(profile)) return CONTINUE;

			// After a compaction the earlier injection was summarised away, so the
			// profile goes back in — briefly, since the transcript is already long.
			const body = formatProfile(profile, { brief: source === "compact" });
			return inject(
				"SessionStart",
				memoryBlock(body, config.maxInjectChars),
			);
		};

		hooks.SessionStart = [ours({ hooks: [onSessionStart] })];
	}

	// Compaction and shutdown are the two moments where a buffered turn would be
	// lost, so both drain the write queue first.
	const drain: HookCallback = async () => {
		await flush();
		return CONTINUE;
	};
	hooks.PreCompact = [ours({ hooks: [drain] })];
	hooks.SessionEnd = [ours({ hooks: [drain] })];

	return hooks;
}

async function recallBody(
	config: ResolvedConfig,
	prompt: string,
): Promise<string | undefined> {
	const result = await guard(
		config,
		"recall",
		() =>
			config.client.recall(prompt, {
				k: config.k,
				...(config.lens === undefined ? {} : { lens: config.lens }),
			}),
		{ timeoutMs: config.injectTimeoutMs },
	);
	return isAvailable(result) ? formatHits(result.hits) : undefined;
}

async function contextBody(
	config: ResolvedConfig,
	prompt: string,
): Promise<string | undefined> {
	const result = await guard(
		config,
		"context",
		() =>
			config.client.context(prompt, {
				k: config.k,
				...(config.lens === undefined ? {} : { lens: config.lens }),
			}),
		{ timeoutMs: config.injectTimeoutMs },
	);
	return isAvailable(result) ? result.context : undefined;
}

/** Whether a matcher is one we added. */
export function isMemoryMatcher(matcher: HookCallbackMatcher): boolean {
	return (matcher as unknown as Record<symbol, unknown>)[MEMORY_HOOKS] === true;
}

/** A copy safe to hand out, so a caller cannot mutate the instance's own. */
export function copyHooks(
	hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	const copy: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
	for (const [event, matchers] of Object.entries(hooks) as [
		HookEvent,
		HookCallbackMatcher[],
	][]) {
		copy[event] = [...matchers];
	}
	return copy;
}
