export { createAgentMemory } from "./memory";

export { MEMORY_SYSTEM_PROMPT } from "./prompt";
export { MEMORY_TAG } from "./format";
export { SESSION_LABEL_KEY } from "./sessions";
export { ALL_TOOLS, DEFAULT_TOOLS } from "./config";

export type {
	AgentMemory,
	AgentMemoryConfig,
	MemoryOp,
	MemoryToolName,
	QueryOverrides,
	RetrievalMode,
	ToolSelection,
	TurnRecord,
} from "./types";

// Re-exported so callers can type scopes, bring their own client, or catch a
// memory error without a second import.
export {
	AuthError,
	CancelledError,
	ConnectionError,
	NotFoundError,
	RateLimitError,
	ScopeError,
	ServerError,
	Spectron,
	SpectronError,
	ValidationError,
} from "@surrealdb/spectron";
export type { BatchMessage, Scope } from "@surrealdb/spectron";
