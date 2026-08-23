import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type Uuid = `${string}-${string}-${string}-${string}-${string}`;

let counter = 0;
const uuid = (): Uuid => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}` as Uuid;

const SESSION = "claude-session-1";

/** A `system`/`init` message, which is how a stream announces its session. */
export function systemInit(sessionId = SESSION): SDKMessage {
	return {
		type: "system",
		subtype: "init",
		apiKeySource: "none",
		claude_code_version: "test",
		cwd: "/tmp",
		tools: [],
		mcp_servers: [],
		model: "claude-sonnet-4-5",
		permissionMode: "default",
		slash_commands: [],
		output_style: "default",
		skills: [],
		plugins: [],
		uuid: uuid(),
		session_id: sessionId,
	} as unknown as SDKMessage;
}

export function userText(
	text: string,
	extra: {
		sessionId?: string;
		isSynthetic?: boolean;
		parentToolUseId?: string;
		shouldQuery?: boolean;
	} = {},
): SDKMessage {
	return {
		type: "user",
		message: { role: "user", content: [{ type: "text", text }] },
		parent_tool_use_id: extra.parentToolUseId ?? null,
		...(extra.isSynthetic ? { isSynthetic: true } : {}),
		...(extra.shouldQuery === undefined ? {} : { shouldQuery: extra.shouldQuery }),
		uuid: uuid(),
		session_id: extra.sessionId ?? SESSION,
	} as unknown as SDKMessage;
}

/** A transcript message replayed when a session is resumed or forked. */
export function replayedUser(text: string, sessionId = SESSION): SDKMessage {
	return {
		type: "user",
		message: { role: "user", content: [{ type: "text", text }] },
		parent_tool_use_id: null,
		isReplay: true,
		uuid: uuid(),
		session_id: sessionId,
	} as unknown as SDKMessage;
}

/** A synthetic user message carrying a tool result, as the SDK emits mid-loop. */
export function toolResult(text: string, sessionId = SESSION): SDKMessage {
	return {
		type: "user",
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "tu_1", content: text }],
		},
		parent_tool_use_id: null,
		uuid: uuid(),
		session_id: sessionId,
	} as unknown as SDKMessage;
}

export function assistantText(
	text: string,
	extra: { sessionId?: string; parentToolUseId?: string; subagentType?: string } = {},
): SDKMessage {
	return {
		type: "assistant",
		message: {
			id: `msg_${counter}`,
			role: "assistant",
			model: "claude-sonnet-4-5",
			type: "message",
			content: [{ type: "text", text }],
			stop_reason: null,
			usage: {},
		},
		parent_tool_use_id: extra.parentToolUseId ?? null,
		...(extra.subagentType ? { subagent_type: extra.subagentType } : {}),
		uuid: uuid(),
		session_id: extra.sessionId ?? SESSION,
	} as unknown as SDKMessage;
}

/** An assistant message whose only block is a tool call. */
export function assistantToolUse(name: string, sessionId = SESSION): SDKMessage {
	return {
		type: "assistant",
		message: {
			id: `msg_${counter}`,
			role: "assistant",
			model: "claude-sonnet-4-5",
			type: "message",
			content: [{ type: "tool_use", id: "tu_1", name, input: {} }],
			stop_reason: null,
			usage: {},
		},
		parent_tool_use_id: null,
		uuid: uuid(),
		session_id: sessionId,
	} as unknown as SDKMessage;
}

export function resultMessage(text = "done", sessionId = SESSION): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		duration_ms: 1,
		duration_api_ms: 1,
		is_error: false,
		num_turns: 1,
		result: text,
		stop_reason: "end_turn",
		total_cost_usd: 0,
		usage: {},
		modelUsage: {},
		permission_denials: [],
		uuid: uuid(),
		session_id: sessionId,
	} as unknown as SDKMessage;
}

/**
 * A `success` result that nonetheless carries an API error: per the SDK, the
 * `result` field then holds the error text rather than assistant prose.
 */
export function errorResult(text: string, sessionId = SESSION): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		duration_ms: 1,
		duration_api_ms: 1,
		is_error: true,
		num_turns: 1,
		result: text,
		stop_reason: null,
		total_cost_usd: 0,
		usage: {},
		modelUsage: {},
		permission_denials: [],
		uuid: uuid(),
		session_id: sessionId,
	} as unknown as SDKMessage;
}

export interface ScriptedQuery extends Query {
	/** Calls made to the delegated control methods. */
	readonly control: string[];
	/** Whether the generator was closed via `return()`. */
	readonly returned: boolean;
}

/**
 * A stand-in for the SDK's `query()` result: yields `messages` in order and
 * records the control-method calls that a wrapper must delegate.
 */
export function scriptedQuery(messages: SDKMessage[]): ScriptedQuery {
	const control: string[] = [];
	let returned = false;

	async function* generate(): AsyncGenerator<SDKMessage, void> {
		for (const message of messages) yield message;
	}

	const generator = generate();

	const query = {
		next: (...args: Parameters<Query["next"]>) => generator.next(...args),
		return: (value: void) => {
			returned = true;
			return generator.return(value);
		},
		throw: (error: unknown) => generator.throw(error),
		[Symbol.asyncIterator]() {
			return query as unknown as AsyncGenerator<SDKMessage, void>;
		},
		interrupt: async () => {
			control.push("interrupt");
		},
		setModel: async (model: string) => {
			control.push(`setModel:${model}`);
		},
		get control() {
			return control;
		},
		get returned() {
			return returned;
		},
	};

	return query as unknown as ScriptedQuery;
}

/** Collects a query's messages into an array. */
export async function drain(query: Query): Promise<SDKMessage[]> {
	const seen: SDKMessage[] = [];
	for await (const message of query) seen.push(message);
	return seen;
}
