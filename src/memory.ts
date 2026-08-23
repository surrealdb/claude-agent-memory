import {
	query as sdkQuery,
	type HookCallbackMatcher,
	type HookEvent,
	type McpSdkServerConfigWithInstance,
	type Options,
	type Query,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { resolveConfig } from "./config";
import { buildHooks, copyHooks } from "./hooks";
import { mergeOptions } from "./options";
import { systemPromptFor } from "./prompt";
import { wrapQuery } from "./query";
import { SessionBinder } from "./sessions";
import { buildMcpServer, toolNames as qualifiedToolNames } from "./tools";
import type {
	AgentMemory,
	AgentMemoryConfig,
	QueryOverrides,
} from "./types";

/**
 * Creates the memory integration for a Claude agent.
 *
 * Connection details fall back to `SPECTRON_ENDPOINT`, `SPECTRON_API_KEY`, and
 * `SPECTRON_CONTEXT`, so a call with no arguments is enough in a configured
 * environment.
 *
 * ```ts
 * const memory = createAgentMemory();
 *
 * for await (const message of memory.query({ prompt: "What am I working on?" })) {
 *   // …
 * }
 * ```
 */
export function createAgentMemory(config: AgentMemoryConfig = {}): AgentMemory {
	const resolved = resolveConfig(config);
	const binder = new SessionBinder(resolved);

	/**
	 * Drains a set of in-flight writes. Looping rather than awaiting once,
	 * because settling one write can enqueue the next turn's; each pass clears
	 * the batch it awaited, so it cannot spin on a settled write whose cleanup
	 * has not run yet.
	 *
	 * Under `failOpen` a write's failure was already swallowed and reported, so
	 * there is nothing here to raise. Failing closed, the caller asked to hear
	 * about it, and a flush is the only place left to tell them.
	 */
	const drain = async (writes: Set<Promise<unknown>>) => {
		let failure: { error: unknown } | undefined;

		while (writes.size > 0) {
			const inflight = [...writes];
			const settled = await Promise.allSettled(inflight);
			for (const write of inflight) writes.delete(write);

			if (resolved.failOpen) continue;
			for (const outcome of settled) {
				if (outcome.status === "rejected") {
					failure ??= { error: outcome.reason };
				}
			}
		}

		if (failure) throw failure.error;
	};

	// Every write, for the instance-wide flush.
	const allPending = new Set<Promise<unknown>>();

	/**
	 * A write tracker scoped to one query. Concurrent queries get their own, so
	 * finishing one never waits on writes belonging to another.
	 */
	const tracker = () => {
		const own = new Set<Promise<unknown>>();
		return {
			track: (write: Promise<unknown>) => {
				own.add(write);
				allPending.add(write);

				// `then` with both arms rather than `finally`: the latter returns a
				// promise that re-raises the rejection with nothing attached to it,
				// which surfaces as an unhandled rejection and, on Node's default
				// settings, kills the process.
				const forget = () => {
					own.delete(write);
					allPending.delete(write);
				};
				void write.then(forget, forget);
			},
			flush: () => drain(own),
		};
	};

	const flush = () => drain(allPending);

	const server: McpSdkServerConfigWithInstance | undefined =
		resolved.tools.length > 0 ? buildMcpServer(resolved) : undefined;
	const toolNames = qualifiedToolNames(resolved);
	const hooks = buildHooks({ config: resolved, binder, flush });
	const promptAppend = systemPromptFor(resolved.serverName, resolved.tools);

	const optionsWith = (
		base: Options | undefined,
		hooksToUse: ReturnType<typeof buildHooks>,
	): Options =>
		mergeOptions({
			base,
			serverName: resolved.serverName,
			server,
			toolNames,
			hooks: hooksToUse,
			systemPromptAppend: resolved.systemPrompt ? promptAppend : undefined,
		});

	const options = (base?: Options): Options => optionsWith(base, hooks);

	/**
	 * Hooks for one call. Retrieval settings live inside the hooks, so a per-call
	 * override of one of them needs its own set rather than the shared one.
	 */
	const hooksFor = (overrides: QueryOverrides) => {
		if (overrides.injectHistory === undefined && overrides.k === undefined) {
			return hooks;
		}

		return buildHooks({
			config: {
				...resolved,
				injectHistory: overrides.injectHistory ?? resolved.injectHistory,
				k: overrides.k ?? resolved.k,
			},
			binder,
			flush,
		});
	};

	return {
		options,

		query(
			params: {
				prompt: string | AsyncIterable<SDKUserMessage>;
				options?: Options;
			},
			overrides: QueryOverrides = {},
		): Query {
			const run = resolved.queryFn ?? sdkQuery;
			const inner = run({
				prompt: params.prompt,
				options: optionsWith(params.options, hooksFor(overrides)),
			});

			return wrapQuery(inner, {
				config: resolved,
				binder,
				overrides,
				...tracker(),
			});
		},

		mcpServer(): McpSdkServerConfigWithInstance {
			if (!server) {
				throw new Error(
					"@surrealdb/claude-agent-memory: no memory tools are enabled, so " +
						"there is no MCP server to expose. Remove `tools: false` from " +
						"createAgentMemory() to get one.",
				);
			}
			return server;
		},

		toolNames: () => [...toolNames],

		// A copy: a caller composing these by hand must not be able to disable
		// injection for the whole instance by assigning into the result.
		hooks: (): Partial<Record<HookEvent, HookCallbackMatcher[]>> =>
			copyHooks(hooks),

		systemPromptAppend: () => promptAppend,

		memorySessionFor: (claudeSessionId: string) =>
			binder.sessionIdFor(claudeSessionId),

		flush,

		client: resolved.client,
	};
}
