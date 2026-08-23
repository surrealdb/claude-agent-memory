import type { ResolvedConfig } from "./config";

/** Label key carrying the Claude session id on every persisted row. */
export const SESSION_LABEL_KEY = "claude_session";

/**
 * Tracks which Agent Memory session each Claude session writes to.
 *
 * Agent Memory creates a session implicitly on the first `rememberMany` that
 * omits one and returns its id, so binding costs no extra round trip: the first
 * write establishes the session and later writes reuse it. Every row is also
 * labelled with the Claude session id, which is what makes the association
 * durable — a later process can find the turns by label without inheriting this
 * in-memory map.
 */
export class SessionBinder {
	private readonly bindings = new Map<string, string>();
	private readonly tails = new Map<string, Promise<unknown>>();

	constructor(private readonly config: ResolvedConfig) {}

	/**
	 * Runs `write` after any earlier write for the same Claude session.
	 *
	 * Writes are otherwise fire-and-forget, which leaves a race on the very
	 * first one: it is the call that creates the session, so a second turn
	 * completing before it returns would omit the session id too and have a
	 * second session created for the same conversation. Serialising per
	 * conversation removes that, and keeps a conversation's turns in order.
	 * Different Claude sessions still write concurrently.
	 */
	serialise<T>(claudeSessionId: string, write: () => Promise<T>): Promise<T> {
		const earlier = this.tails.get(claudeSessionId);
		const mine = earlier ? earlier.then(write, write) : write();

		// The tail must never reject, or it would fail the turn that follows it.
		const tail = mine.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(claudeSessionId, tail);
		void tail.then(() => {
			if (this.tails.get(claudeSessionId) === tail) {
				this.tails.delete(claudeSessionId);
			}
		});

		return mine;
	}

	/** The memory session id to send with a write, if any. */
	sessionIdFor(claudeSessionId: string, override?: string | false): string | undefined {
		const pinned = override ?? this.config.sessionId;
		if (pinned === false) return undefined;
		if (typeof pinned === "string") return pinned;
		return this.bindings.get(claudeSessionId);
	}

	/** Whether writes for this session should carry a session id at all. */
	usesSessions(override?: string | false): boolean {
		return (override ?? this.config.sessionId) !== false;
	}

	/** Records the session id a write reported, first one wins. */
	bind(claudeSessionId: string, memorySessionId: string): void {
		if (!memorySessionId || this.bindings.has(claudeSessionId)) return;

		this.bindings.set(claudeSessionId, memorySessionId);
		try {
			this.config.onSession?.({ claudeSessionId, memorySessionId });
		} catch {
			// A notification callback must not break the write path.
		}
	}

	/** The labels to record on writes for a Claude session. */
	labelsFor(claudeSessionId: string, extra: string[] = []): string[] {
		return [
			...this.config.labels,
			...extra,
			`${SESSION_LABEL_KEY}=${claudeSessionId}`,
		];
	}

	get bound(): ReadonlyMap<string, string> {
		return this.bindings;
	}
}
