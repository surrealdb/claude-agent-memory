import type { BatchMessage, Scope, Spectron } from "@surrealdb/spectron";
import type {
	HookCallbackMatcher,
	HookEvent,
	McpSdkServerConfigWithInstance,
	Options,
	Query,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** A memory tool exposed to the model over the in-process MCP server. */
export type MemoryToolName =
	| "recall"
	| "context"
	| "remember"
	| "reflect"
	| "profile"
	| "inspect"
	| "forget";

/** Named memory operation, reported to {@link AgentMemoryConfig.onError}. */
export type MemoryOp =
	| "recall"
	| "context"
	| "profile"
	| "remember"
	| "rememberMany"
	| "reflect"
	| "forget"
	| "inspect";

/** How recalled memory is rendered before it is injected into a turn. */
export type RetrievalMode = "context" | "recall";

/** Which memory tools to expose. */
export type ToolSelection =
	| MemoryToolName[]
	| { include?: MemoryToolName[]; exclude?: MemoryToolName[] }
	| false;

/**
 * One captured exchange, handed to {@link AgentMemoryConfig.onTurn} after the
 * write to Agent Memory settles.
 */
export interface TurnRecord {
	/** Claude session the exchange belongs to. */
	claudeSessionId: string;
	/** Agent Memory session the turns were attached to, when known. */
	memorySessionId: string | undefined;
	/** The messages as they were sent to Agent Memory. */
	messages: BatchMessage[];
	/** `false` when storing was disabled or the write failed under `failOpen`. */
	persisted: boolean;
	/** The failure, when `persisted` is `false` because the write threw. */
	error?: unknown;
}

export interface AgentMemoryConfig {
	// ---- connection ----------------------------------------------------------

	/** API endpoint origin. Defaults to `process.env.SPECTRON_ENDPOINT`. */
	endpoint?: string;
	/** Bearer API key. Defaults to `process.env.SPECTRON_API_KEY`. */
	apiKey?: string;
	/** Agent Memory context id. Defaults to `process.env.SPECTRON_CONTEXT`. */
	context?: string;
	/**
	 * A pre-built client to use instead of constructing one — e.g.
	 * `base.onBehalfOf(userId)` for per-request delegation. Takes precedence
	 * over `endpoint` / `apiKey` / `context`.
	 */
	client?: Spectron;
	/** Request timeout in ms, forwarded to the client. Defaults to `30_000`. */
	timeout?: number;
	/** Max retries for idempotent requests, forwarded to the client. */
	maxRetries?: number;
	/** Override `fetch`, forwarded to the client. */
	fetchImpl?: typeof fetch;

	// ---- scoping -------------------------------------------------------------

	/** Default DNF scope selector for writes (outer OR, inner AND). */
	scopes?: Scope;
	/** Default DNF read lens for recall and context. */
	lens?: Scope;
	/** Extra `key=value` labels recorded on every write. */
	labels?: string[];

	// ---- sessions ------------------------------------------------------------

	/**
	 * How captured turns attach to an Agent Memory session.
	 *
	 * - omitted — a session is created on the first write of each Claude session
	 *   and reused for the rest of it (recommended).
	 * - a string — pin every write to this existing Agent Memory session id.
	 * - `false` — do not attach turns to any session.
	 */
	sessionId?: string | false;
	/**
	 * Called the first time a Claude session is bound to an Agent Memory
	 * session. Persist the pair to resume the same memory session in a later
	 * process by passing it back as `sessionId`.
	 */
	onSession?: (binding: {
		claudeSessionId: string;
		memorySessionId: string;
	}) => void;

	// ---- behaviour -----------------------------------------------------------

	/** Inject recalled memory on every prompt. Defaults to `true`. */
	injectHistory?: boolean;
	/** Inject the user profile at session start. Defaults to `true`. */
	injectProfile?: boolean;
	/** Persist captured turns from `memory.query()`. Defaults to `true`. */
	store?: boolean;
	/** Maximum hits to retrieve when injecting memory. Defaults to `8`. */
	k?: number;
	/** How injected memory is rendered. Defaults to `"context"`. */
	retrieval?: RetrievalMode;
	/** Truncation cap for an injected memory block. Defaults to `4000`. */
	maxInjectChars?: number;
	/** Bulk extraction strategy for captured turns. */
	extract?: "per_message" | "whole_conversation";

	// ---- surface -------------------------------------------------------------

	/**
	 * Which memory tools to expose. Defaults to every tool except the
	 * destructive `forget`. Pass `false` to expose none.
	 */
	tools?: ToolSelection;
	/** MCP server name; tools surface as `mcp__<serverName>__<tool>`. */
	serverName?: string;
	/** Append the memory system prompt in `options()`. Defaults to `true`. */
	systemPrompt?: boolean;

	// ---- resilience ----------------------------------------------------------

	/**
	 * Swallow memory failures so an outage degrades the agent instead of
	 * breaking it. Defaults to `true`.
	 */
	failOpen?: boolean;
	/**
	 * Budget for a memory call made on the critical path of a turn. Defaults to
	 * `3000`.
	 */
	injectTimeoutMs?: number;
	/**
	 * Budget for persisting one turn. Defaults to `15_000`. Writes are awaited
	 * when a stream ends, before a compaction, and at session end, so an
	 * unbounded write would stall those.
	 */
	writeTimeoutMs?: number;
	/** Notified for every swallowed memory failure. */
	onError?: (error: unknown, op: MemoryOp) => void;
	/** Notified after each captured turn's write settles. */
	onTurn?: (turn: TurnRecord) => void;
	/** Log operation names and durations (never payloads) to `console.debug`. */
	debug?: boolean;

	/**
	 * Replaces the Agent SDK's `query` in `memory.query()`. Test seam.
	 * @internal
	 */
	_queryFn?: (params: {
		prompt: string | AsyncIterable<SDKUserMessage>;
		options?: Options;
	}) => Query;
}

/**
 * Per-call overrides for {@link AgentMemory.query}.
 *
 * There is deliberately no `lens` here. A read lens should also narrow what the
 * memory tools can see, and those live on the MCP server built once per
 * instance, so a per-call lens would only half apply. Build one memory per
 * tenant instead — see the multi-tenant example.
 */
export interface QueryOverrides {
	/** Pin this call's turns to a memory session, or `false` to detach them. */
	sessionId?: string | false;
	/** Write scopes for this call's turns. */
	scopes?: Scope;
	/** Extra labels on this call's writes. */
	labels?: string[];
	/** Persist this call's turns. */
	store?: boolean;
	/** Inject recalled memory on this call's prompts. */
	injectHistory?: boolean;
	/** How many hits to inject on this call. Does not change the tools' default. */
	k?: number;
	/** Notified after each of this call's turns settles. */
	onTurn?: (turn: TurnRecord) => void;
}

export interface AgentMemory {
	/**
	 * Merges the memory MCP server, hooks, allowed tools, and system-prompt
	 * append into `base`, returning new options. Does not mutate `base`, and is
	 * safe to apply twice.
	 */
	options(base?: Options): Options;

	/**
	 * Runs the Agent SDK's `query()` with memory wired in, additionally
	 * capturing each exchange and persisting it to Agent Memory. Yields exactly
	 * the messages the underlying query yields.
	 */
	query(
		params: {
			prompt: string | AsyncIterable<SDKUserMessage>;
			options?: Options;
		},
		overrides?: QueryOverrides,
	): Query;

	/** The in-process MCP server carrying the memory tools. */
	mcpServer(): McpSdkServerConfigWithInstance;

	/** Fully-qualified tool names, for `allowedTools`. */
	toolNames(): string[];

	/** The memory hooks, for manual composition. */
	hooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>>;

	/** The system-prompt text `options()` appends. */
	systemPromptAppend(): string;

	/** The Agent Memory session bound to a Claude session, once known. */
	memorySessionFor(claudeSessionId: string): string | undefined;

	/** Awaits every in-flight write. */
	flush(): Promise<void>;

	/** The underlying Agent Memory client. */
	readonly client: Spectron;
}
