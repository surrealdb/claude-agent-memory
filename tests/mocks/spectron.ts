import type { Spectron } from "@surrealdb/spectron";
import type { MemoryOp } from "../../src/types";

export interface RecordedCall {
	op: MemoryOp;
	args: unknown[];
}

/**
 * A stand-in for the Agent Memory client covering only the surface this package
 * touches. Injected through the public `client` option, so no module mocking is
 * involved.
 */
export class MockSpectron {
	readonly calls: RecordedCall[] = [];

	private readonly failures = new Map<MemoryOp, unknown>();
	private readonly delays = new Map<MemoryOp, number>();
	private sessionCounter = 0;

	/** Canned payloads, overridable per test. */
	hits: { id: string; score: number; source: string; text: string }[] = [
		{ id: "fact:1", score: 0.9, source: "fact", text: "Prefers dark mode" },
	];
	contextText = "The user prefers dark mode and works on SurrealDB.";
	profilePayload = {
		static: [{ key: "name", value: "Tobie" }],
		dynamic: [{ key: "mood", value: "focused" }],
		preferences: [{ key: "theme", value: "dark" }],
		instructions: [
			{ id: "i1", label: "Be brief", description: "Prefers short answers" },
		],
	};
	reflectPayload = {
		reflection: "They shifted to Lisbon this month.",
		evidence: ["moved to Lisbon"],
		persistedAttributes: [],
		traceId: "trace:1",
	};

	/** Makes `op` reject with `error`. */
	failWith(op: MemoryOp, error: unknown): this {
		this.failures.set(op, error);
		return this;
	}

	/** Makes `op` take `ms` before resolving. */
	delay(op: MemoryOp, ms: number): this {
		this.delays.set(op, ms);
		return this;
	}

	callsFor(op: MemoryOp): RecordedCall[] {
		return this.calls.filter((call) => call.op === op);
	}

	/** Type-erased view for passing into `createAgentMemory({ client })`. */
	asClient(): Spectron {
		return this as unknown as Spectron;
	}

	private async record<T>(op: MemoryOp, args: unknown[], value: T): Promise<T> {
		this.calls.push({ op, args });

		const wait = this.delays.get(op);
		if (wait !== undefined) {
			await new Promise((resolve) => setTimeout(resolve, wait));
		}

		const failure = this.failures.get(op);
		if (failure !== undefined) throw failure;

		return value;
	}

	recall(query: string, options?: unknown) {
		return this.record("recall", [query, options], {
			hits: this.hits,
			classificationKind: "hybrid",
			queryMs: 1,
			seedEntities: [],
			tier: "t1",
			trace: {},
		});
	}

	context(query: string, options?: unknown) {
		return this.record("context", [query, options], {
			context: this.contextText,
			queryMs: 1,
			tier: "t1",
		});
	}

	profile() {
		return this.record("profile", [], this.profilePayload);
	}

	remember(text?: string, options?: unknown) {
		return this.record("remember", [text, options], {
			mode: "full",
			sessionId: "session:remember",
		});
	}

	rememberMany(messages: unknown[], options?: unknown) {
		const pinned = (options as { sessionId?: string } | undefined)?.sessionId;
		const sessionId = pinned ?? `session:${++this.sessionCounter}`;
		return this.record("rememberMany", [messages, options], {
			extractions: [],
			sessionId,
			turnIds: ["turn:1"],
		});
	}

	reflect(query: string, options?: unknown) {
		return this.record("reflect", [query, options], this.reflectPayload);
	}

	forget(query: string, options?: unknown) {
		return this.record("forget", [query, options], { deleted: 3 });
	}

	inspect(ref: string, options?: unknown) {
		return this.record("inspect", [ref, options], {
			kind: "entity",
			entity: { id: ref },
			attributes: [],
			relations: [],
		});
	}
}
