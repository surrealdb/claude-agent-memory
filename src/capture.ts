import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BatchMessage } from "@surrealdb/spectron";

/** A turn ready to be written to memory. */
export interface CapturedTurn {
	claudeSessionId: string;
	messages: BatchMessage[];
}

/**
 * Reads exchanges out of the message stream.
 *
 * Only the human-facing halves of a turn are kept. Tool results arrive as user
 * messages and tool calls as assistant messages, but neither is anything the
 * user said or was told, and storing them would fill memory with the agent
 * talking to itself. Subagent traffic is skipped for the same reason.
 */
export class TurnCapture {
	private readonly seen = new Set<string>();
	private buffer: BatchMessage[] = [];
	private sessionId: string | undefined;

	/** The Claude session id seen on the stream, once known. */
	get claudeSessionId(): string | undefined {
		return this.sessionId;
	}

	/**
	 * Folds one message in. Returns a turn when the message closed one, which
	 * happens on the `result` message that ends a request.
	 */
	observe(message: SDKMessage): CapturedTurn | undefined {
		if (isFromSubagent(message)) return undefined;

		if ("session_id" in message && typeof message.session_id === "string") {
			this.sessionId ??= message.session_id;
		}

		switch (message.type) {
			case "user": {
				// A resumed or forked session replays its transcript before the live
				// prompt. Those turns are already in memory, and folding them in
				// would weld last week's questions onto this one.
				if (message.isSynthetic || isReplay(message)) break;

				// Appended to the transcript without starting a turn; it is merged
				// into whichever message does, so let that one carry it.
				if (message.shouldQuery === false) break;

				const id = message.uuid;
				if (id !== undefined && this.seen.has(id)) break;
				if (id !== undefined) this.seen.add(id);

				const content = extractText(message.message.content);
				if (content) this.push("user", content);
				break;
			}

			case "assistant": {
				const id = message.uuid;
				if (this.seen.has(id)) break;
				this.seen.add(id);

				const content = extractText(message.message.content);
				if (content) this.push("assistant", content);
				break;
			}

			case "result": {
				// The stream can end without any assistant text of its own, and the
				// result payload still carries what the user was told. But on
				// `is_error` that same field holds the API's error text, which is not
				// something the assistant said and must never be stored as such.
				if (
					message.subtype === "success" &&
					!message.is_error &&
					!this.buffer.some((entry) => entry.role === "assistant") &&
					message.result.trim()
				) {
					this.push("assistant", message.result.trim());
				}

				// A turn that failed still keeps the user's half: what they told us is
				// true whether or not the model got to answer.
				return this.flush();
			}

			default:
				break;
		}

		return undefined;
	}

	/** Closes the current turn, if anything worth storing was captured. */
	flush(): CapturedTurn | undefined {
		const messages = this.buffer;
		this.buffer = [];

		// Ids are only tracked to absorb a message delivered twice within a turn;
		// transcript replays are filtered by their own marker, not by this set.
		// Forgetting the ids at the turn boundary keeps a long streaming session
		// from accumulating every id it ever saw.
		this.seen.clear();

		if (messages.length === 0 || this.sessionId === undefined) return undefined;
		return { claudeSessionId: this.sessionId, messages };
	}

	private push(role: "user" | "assistant", content: string): void {
		// One model turn can arrive as several assistant messages; they read as one
		// reply, so they are joined rather than stored as separate turns.
		const last = this.buffer.at(-1);
		if (last && last.role === role) {
			last.content = `${last.content}\n\n${content}`;
			return;
		}

		this.buffer.push({ role, content });
	}
}

/** Transcript replayed on resume or fork, rather than something said now. */
function isReplay(message: SDKMessage): boolean {
	return (message as { isReplay?: boolean }).isReplay === true;
}

function isFromSubagent(message: SDKMessage): boolean {
	if ("subagent_type" in message && message.subagent_type !== undefined)
		return true;
	return (
		"parent_tool_use_id" in message &&
		typeof message.parent_tool_use_id === "string"
	);
}

type ContentBlocks = Extract<
	SDKMessage & { type: "user" | "assistant" },
	{ message: unknown }
>["message"]["content"];

/**
 * Pulls the prose out of message content, dropping thinking, tool calls, tool
 * results, and attachments.
 */
export function extractText(content: ContentBlocks): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";

	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text.trim())
		.filter((text) => text.length > 0)
		.join("\n\n")
		.trim();
}
