import { Spectron } from "@surrealdb/spectron";
import type { AgentMemoryConfig, MemoryToolName, ToolSelection } from "./types";

/** Every tool the server can expose, in the order they are registered. */
export const ALL_TOOLS: readonly MemoryToolName[] = [
	"recall",
	"context",
	"remember",
	"reflect",
	"profile",
	"inspect",
	"forget",
];

/** Tools exposed unless the caller says otherwise — `forget` is destructive. */
export const DEFAULT_TOOLS: readonly MemoryToolName[] = ALL_TOOLS.filter(
	(name) => name !== "forget",
);

/** Config with every default applied. */
export type ResolvedConfig = ReturnType<typeof resolveConfig>;

function selectTools(selection: ToolSelection | undefined): MemoryToolName[] {
	if (selection === false) return [];
	if (selection === undefined) return [...DEFAULT_TOOLS];
	if (Array.isArray(selection)) {
		const wanted = new Set(selection);
		return ALL_TOOLS.filter((name) => wanted.has(name));
	}

	const { include = [], exclude = [] } = selection;
	const chosen = new Set<MemoryToolName>([...DEFAULT_TOOLS, ...include]);
	for (const name of exclude) chosen.delete(name);
	return ALL_TOOLS.filter((name) => chosen.has(name));
}

function resolveClient(config: AgentMemoryConfig): Spectron {
	if (config.client) return config.client;

	const endpoint = config.endpoint ?? process.env.SPECTRON_ENDPOINT;
	const apiKey = config.apiKey ?? process.env.SPECTRON_API_KEY;
	const context = config.context ?? process.env.SPECTRON_CONTEXT;

	const missing = [
		endpoint ? undefined : "endpoint (SPECTRON_ENDPOINT)",
		apiKey ? undefined : "apiKey (SPECTRON_API_KEY)",
		context ? undefined : "context (SPECTRON_CONTEXT)",
	].filter((entry): entry is string => entry !== undefined);

	if (missing.length > 0) {
		throw new Error(
			`@surrealdb/claude-agent-memory: missing ${missing.join(", ")}. ` +
				"Pass them to createAgentMemory({ endpoint, apiKey, context }), " +
				"set the environment variables, or supply your own { client }.",
		);
	}

	return new Spectron({
		// biome-ignore lint/style/noNonNullAssertion: checked above
		endpoint: endpoint!,
		// biome-ignore lint/style/noNonNullAssertion: checked above
		apiKey: apiKey!,
		// biome-ignore lint/style/noNonNullAssertion: checked above
		context: context!,
		...(config.timeout === undefined ? {} : { timeout: config.timeout }),
		...(config.maxRetries === undefined
			? {}
			: { maxRetries: config.maxRetries }),
		...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
	});
}

/**
 * Applies defaults and constructs the client. Throws when the connection is
 * underspecified: misconfiguration should surface at startup, not as a silently
 * memory-less agent.
 */
export function resolveConfig(config: AgentMemoryConfig = {}) {
	return {
		client: resolveClient(config),
		scopes: config.scopes,
		lens: config.lens,
		labels: config.labels ?? [],
		sessionId: config.sessionId,
		onSession: config.onSession,
		injectHistory: config.injectHistory ?? true,
		injectProfile: config.injectProfile ?? true,
		store: config.store ?? true,
		k: config.k ?? 8,
		retrieval: config.retrieval ?? "context",
		maxInjectChars: config.maxInjectChars ?? 4000,
		extract: config.extract,
		tools: selectTools(config.tools),
		serverName: config.serverName ?? "spectron",
		systemPrompt: config.systemPrompt ?? true,
		failOpen: config.failOpen ?? true,
		injectTimeoutMs: config.injectTimeoutMs ?? 3000,
		writeTimeoutMs: config.writeTimeoutMs ?? 15_000,
		onError: config.onError,
		onTurn: config.onTurn,
		debug: config.debug ?? false,
		queryFn: config._queryFn,
	} as const;
}
