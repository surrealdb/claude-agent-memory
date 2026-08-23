import { describe, expect, test } from "bun:test";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ConnectionError, RateLimitError } from "@surrealdb/spectron";
import { resolveConfig } from "../src/config";
import { createAgentMemory } from "../src/memory";
import { wrapQuery } from "../src/query";
import { SESSION_LABEL_KEY, SessionBinder } from "../src/sessions";
import type { AgentMemoryConfig, QueryOverrides, TurnRecord } from "../src/types";
import { MockSpectron } from "./mocks/spectron";
import {
	assistantText,
	drain,
	resultMessage,
	scriptedQuery,
	systemInit,
	userText,
	type ScriptedQuery,
} from "./mocks/sdk";

const ONE_TURN: SDKMessage[] = [
	systemInit(),
	userText("I moved to Lisbon"),
	assistantText("Noted."),
	resultMessage(),
];

/** One exchange belonging to a named Claude session. */
const turnFor = (sessionId: string): SDKMessage[] => [
	systemInit(sessionId),
	userText("hello", { sessionId }),
	assistantText("hi", { sessionId }),
	resultMessage("hi", sessionId),
];

function setup(
	messages: SDKMessage[] = ONE_TURN,
	config: Partial<AgentMemoryConfig> = {},
) {
	const spectron = new MockSpectron();
	const turns: TurnRecord[] = [];
	let scripted: ScriptedQuery | undefined;

	const memory = createAgentMemory({
		client: spectron.asClient(),
		onTurn: (turn) => turns.push(turn),
		_queryFn: () => {
			scripted = scriptedQuery(messages);
			return scripted;
		},
		...config,
	});

	const run = (overrides?: QueryOverrides) =>
		memory.query({ prompt: "hello" }, overrides);

	return { spectron, memory, turns, run, scripted: () => scripted };
}

const writes = (spectron: MockSpectron) => spectron.callsFor("rememberMany");
const optionsOf = (spectron: MockSpectron, index = 0) =>
	writes(spectron)[index]?.args[1] as Record<string, unknown>;

describe("pass-through", () => {
	test("yields every message, unchanged and in order", async () => {
		const { run } = setup();

		const seen = await drain(run());

		expect(seen).toEqual(ONE_TURN);
	});

	test("delegates control methods to the underlying query", async () => {
		const { run, scripted } = setup();
		const query = run();

		await query.next();
		await query.interrupt();
		await query.setModel("claude-opus-4");

		expect(scripted()?.control).toEqual(["interrupt", "setModel:claude-opus-4"]);
	});

	test("is iterable more than once through the same handle", async () => {
		const { run } = setup();
		const query: Query = run();

		const first = await query.next();
		const rest: SDKMessage[] = [];
		for await (const message of query) rest.push(message);

		expect(first.value).toEqual(ONE_TURN[0]);
		expect(rest).toEqual(ONE_TURN.slice(1));
	});
});

describe("persistence", () => {
	test("writes one batch per completed turn", async () => {
		const { spectron, run } = setup();

		await drain(run());

		expect(writes(spectron)).toHaveLength(1);
		expect(writes(spectron)[0]?.args[0]).toEqual([
			{ role: "user", content: "I moved to Lisbon" },
			{ role: "assistant", content: "Noted." },
		]);
	});

	test("labels every row with the Claude session", async () => {
		const { spectron, run } = setup();

		await drain(run());

		expect(optionsOf(spectron).labels).toContain(
			`${SESSION_LABEL_KEY}=claude-session-1`,
		);
	});

	test("carries configured scopes and labels", async () => {
		const { spectron, run } = setup(ONE_TURN, {
			scopes: "user/tobie",
			labels: ["app=demo"],
		});

		await drain(run());

		expect(optionsOf(spectron)).toMatchObject({ scopes: "user/tobie" });
		expect(optionsOf(spectron).labels).toContain("app=demo");
	});

	test("per-call overrides beat the configured defaults", async () => {
		const { spectron, run } = setup(ONE_TURN, { scopes: "user/default" });

		await drain(run({ scopes: "team/eng", labels: ["run=1"] }));

		expect(optionsOf(spectron)).toMatchObject({ scopes: "team/eng" });
		expect(optionsOf(spectron).labels).toContain("run=1");
	});

	test("has written everything by the time the stream ends", async () => {
		const { spectron, run } = setup();

		for await (const message of run()) {
			if (message.type === "result") {
				// The write is still in flight here; it must have landed by the time
				// iteration completes.
			}
		}

		expect(writes(spectron)).toHaveLength(1);
	});

	test("writes nothing when storing is off, but still reports the turn", async () => {
		const { spectron, turns, run } = setup(ONE_TURN, { store: false });

		await drain(run());

		expect(writes(spectron)).toHaveLength(0);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.persisted).toBe(false);
	});

	test("an override can disable storing for one call", async () => {
		const { spectron, run } = setup();

		await drain(run({ store: false }));

		expect(writes(spectron)).toHaveLength(0);
	});
});

describe("sessions", () => {
	const TWO_TURNS: SDKMessage[] = [
		systemInit(),
		userText("first"),
		assistantText("one"),
		resultMessage(),
		userText("second"),
		assistantText("two"),
		resultMessage(),
	];

	test("creates a session on the first write and reuses it after", async () => {
		const { spectron, memory, run } = setup(TWO_TURNS);

		await drain(run());

		expect(writes(spectron)).toHaveLength(2);
		expect(optionsOf(spectron, 0).sessionId).toBeUndefined();
		expect(optionsOf(spectron, 1).sessionId).toBe("session:1");
		expect(memory.memorySessionFor("claude-session-1")).toBe("session:1");
	});

	test("creates only one session when turns outrun the first write", async () => {
		const { spectron, memory, run } = setup(TWO_TURNS);

		// The first write is what creates the session. If a second turn's write
		// could start before it returns, the service would create a second session
		// for the same conversation and orphan those rows.
		spectron.delay("rememberMany", 120);

		await drain(run());

		expect(writes(spectron)).toHaveLength(2);
		expect(optionsOf(spectron, 0).sessionId).toBeUndefined();
		expect(optionsOf(spectron, 1).sessionId).toBe("session:1");
		expect(memory.memorySessionFor("claude-session-1")).toBe("session:1");
	});

	test("stores a conversation's turns in order", async () => {
		const { spectron, run } = setup(TWO_TURNS);
		spectron.delay("rememberMany", 60);

		await drain(run());

		const first = writes(spectron)[0]?.args[0] as { content: string }[];
		const second = writes(spectron)[1]?.args[0] as { content: string }[];

		expect(first[0]?.content).toBe("first");
		expect(second[0]?.content).toBe("second");
	});

	test("announces the binding so it can be resumed later", async () => {
		const bindings: { claudeSessionId: string; memorySessionId: string }[] = [];
		const { run } = setup(TWO_TURNS, {
			onSession: (binding) => bindings.push(binding),
		});

		await drain(run());

		expect(bindings).toEqual([
			{ claudeSessionId: "claude-session-1", memorySessionId: "session:1" },
		]);
	});

	test("a pinned session is used from the very first write", async () => {
		const { spectron, run } = setup(TWO_TURNS, { sessionId: "session:pinned" });

		await drain(run());

		expect(optionsOf(spectron, 0).sessionId).toBe("session:pinned");
		expect(optionsOf(spectron, 1).sessionId).toBe("session:pinned");
	});

	test("sessionId false keeps turns unattached", async () => {
		const { spectron, memory, run } = setup(TWO_TURNS, { sessionId: false });

		await drain(run());

		expect(optionsOf(spectron, 0).sessionId).toBeUndefined();
		expect(optionsOf(spectron, 1).sessionId).toBeUndefined();
		expect(memory.memorySessionFor("claude-session-1")).toBeUndefined();
	});
});

describe("resilience", () => {
	test("a failed write leaves the stream intact and is reported", async () => {
		const { spectron, turns, run } = setup();
		spectron.failWith(
			"rememberMany",
			new ConnectionError({ status: 0, title: "down" }),
		);

		const seen = await drain(run());

		expect(seen).toEqual(ONE_TURN);
		expect(turns[0]?.persisted).toBe(false);
	});

	test("retries a write once when told to wait briefly", async () => {
		const { spectron, turns, run } = setup();
		let attempts = 0;
		const original = spectron.rememberMany.bind(spectron);
		spectron.rememberMany = ((messages: unknown[], options?: unknown) => {
			attempts += 1;
			if (attempts === 1) {
				throw new RateLimitError({ status: 429, title: "slow", retryAfter: 0.01 });
			}
			return original(messages as never, options as never);
		}) as typeof spectron.rememberMany;

		await drain(run());

		expect(attempts).toBe(2);
		expect(turns[0]?.persisted).toBe(true);
	});

	test("a throwing observer does not break the stream", async () => {
		const { run } = setup(ONE_TURN, {
			onTurn: () => {
				throw new Error("observer exploded");
			},
		});

		expect(await drain(run())).toEqual(ONE_TURN);
	});

	test("stopping early still persists the turns that completed", async () => {
		const { spectron, run } = setup();
		const query = run();

		for await (const message of query) {
			if (message.type === "result") break;
		}

		expect(writes(spectron)).toHaveLength(1);
	});

	test("flush() is safe when nothing is pending", async () => {
		const { memory } = setup();

		await expect(memory.flush()).resolves.toBeUndefined();
	});

	test("reports the failure itself, not just that one happened", async () => {
		const { spectron, turns, run } = setup();
		const boom = new ConnectionError({ status: 0, title: "down" });
		spectron.failWith("rememberMany", boom);

		await drain(run());

		expect(turns[0]?.persisted).toBe(false);
		expect(turns[0]?.error).toBe(boom);
	});

	test("a failing write does not raise an unhandled rejection", async () => {
		const spectron = new MockSpectron();
		spectron.failWith("rememberMany", new Error("write failed"));

		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);

		try {
			// Failing closed is the case that rethrows out of the write, which is
			// what used to escape as an unhandled rejection and kill the process.
			const memory = createAgentMemory({
				client: spectron.asClient(),
				failOpen: false,
				_queryFn: () => scriptedQuery(ONE_TURN),
			});

			await expect(drain(memory.query({ prompt: "hi" }))).rejects.toThrow(
				"write failed",
			);
			await Bun.sleep(50);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(unhandled).toEqual([]);
	});

	test("failing closed surfaces a write failure to the caller", async () => {
		const spectron = new MockSpectron();
		spectron.failWith("rememberMany", new Error("write failed"));

		const memory = createAgentMemory({
			client: spectron.asClient(),
			failOpen: false,
			_queryFn: () => scriptedQuery(ONE_TURN),
		});

		// The README promises write failures throw when failing closed; the flush
		// at the end of the stream is where that has to happen.
		await expect(drain(memory.query({ prompt: "hi" }))).rejects.toThrow(
			"write failed",
		);
	});

	test("persists captured turns when the stream itself fails", async () => {
		const spectron = new MockSpectron();
		const failing = [...ONE_TURN];

		const memory = createAgentMemory({
			client: spectron.asClient(),
			_queryFn: () => {
				const inner = scriptedQuery(failing);
				let index = 0;
				return {
					...inner,
					next: async () => {
						if (index >= failing.length) throw new Error("stream died");
						const value = failing[index++] as SDKMessage;
						return { done: false, value };
					},
					[Symbol.asyncIterator]() {
						return this;
					},
				} as never;
			},
		});

		await expect(drain(memory.query({ prompt: "hi" }))).rejects.toThrow(
			"stream died",
		);

		// The turn completed before the stream broke, so it must have landed.
		expect(writes(spectron)).toHaveLength(1);
	});

	test("a slow conversation does not hold up an unrelated one", async () => {
		const spectron = new MockSpectron();
		const streams = new Map<string, SDKMessage[]>([
			["slow-session", turnFor("slow-session")],
			["fast-session", turnFor("fast-session")],
		]);

		const memory = createAgentMemory({
			client: spectron.asClient(),
			_queryFn: ({ prompt }) =>
				scriptedQuery(streams.get(prompt as string) ?? ONE_TURN),
		});

		// One conversation leaves a slow write in flight...
		spectron.delay("rememberMany", 300);
		const slow = drain(memory.query({ prompt: "slow-session" }));

		// ...while a different conversation, whose write is fast, must not wait.
		await Bun.sleep(10);
		spectron.delay("rememberMany", 0);

		const started = Date.now();
		await drain(memory.query({ prompt: "fast-session" }));
		const elapsed = Date.now() - started;

		expect(elapsed).toBeLessThan(200);
		await slow;

		// The instance-wide flush still covers everything.
		await memory.flush();
		expect(writes(spectron)).toHaveLength(2);
	});
});

describe("wiring", () => {
	test("the wrapped query receives the merged options", async () => {
		const spectron = new MockSpectron();
		let received: unknown;

		const memory = createAgentMemory({
			client: spectron.asClient(),
			_queryFn: (params) => {
				received = params.options;
				return scriptedQuery(ONE_TURN);
			},
		});

		await drain(memory.query({ prompt: "hi", options: { model: "m" } }));

		expect(received).toMatchObject({ model: "m" });
		expect((received as { mcpServers: object }).mcpServers).toHaveProperty(
			"spectron",
		);
	});

	test("a per-call k reaches the injecting hook", async () => {
		const spectron = new MockSpectron();
		let captured: Record<string, unknown> | undefined;

		const memory = createAgentMemory({
			client: spectron.asClient(),
			k: 8,
			_queryFn: (params) => {
				captured = params.options as Record<string, unknown>;
				return scriptedQuery(ONE_TURN);
			},
		});

		await drain(memory.query({ prompt: "hi" }, { k: 2 }));

		const hooks = captured?.hooks as {
			UserPromptSubmit?: { hooks: ((...args: never[]) => Promise<unknown>)[] }[];
		};
		const hook = hooks.UserPromptSubmit?.[0]?.hooks[0];
		await hook?.(
			{
				hook_event_name: "UserPromptSubmit",
				prompt: "where do I live",
				session_id: "claude-session-1",
				transcript_path: "/tmp/t",
				cwd: "/tmp",
			} as never,
			undefined as never,
			{ signal: new AbortController().signal } as never,
		);

		expect(spectron.callsFor("context")[0]?.args[1]).toMatchObject({ k: 2 });
	});

	test("a per-call injectHistory:false removes the injecting hook", async () => {
		const spectron = new MockSpectron();
		let captured: Record<string, unknown> | undefined;

		const memory = createAgentMemory({
			client: spectron.asClient(),
			_queryFn: (params) => {
				captured = params.options as Record<string, unknown>;
				return scriptedQuery(ONE_TURN);
			},
		});

		await drain(memory.query({ prompt: "hi" }, { injectHistory: false }));

		expect(
			(captured?.hooks as { UserPromptSubmit?: unknown[] }).UserPromptSubmit,
		).toBeUndefined();
	});

	test("per-call overrides still apply when options are already wired", async () => {
		const spectron = new MockSpectron();
		let captured: Record<string, unknown> | undefined;

		const memory = createAgentMemory({
			client: spectron.asClient(),
			_queryFn: (params) => {
				captured = params.options as Record<string, unknown>;
				return scriptedQuery(ONE_TURN);
			},
		});

		// The composition the README documents: options() to merge, query() to
		// capture. The override must not be lost to the idempotence guard.
		await drain(
			memory.query(
				{ prompt: "hi", options: memory.options({ model: "m" }) },
				{ injectHistory: false },
			),
		);

		expect(
			(captured?.hooks as { UserPromptSubmit?: unknown[] }).UserPromptSubmit,
		).toBeUndefined();
	});

	test("delegates prototype members to the real query", async () => {
		const spectron = new MockSpectron();
		const memory = createAgentMemory({ client: spectron.asClient() });

		// A real async generator, so its prototype chain differs from a plain
		// object's — which is what makes the delegation observable.
		async function* generate() {
			for (const message of ONE_TURN) yield message;
		}
		const inner = generate();

		const wrapped = wrapQuery(inner as never, {
			config: resolveConfig({ client: spectron.asClient() }),
			binder: new SessionBinder(resolveConfig({ client: spectron.asClient() })),
			overrides: {},
			track: () => {},
			flush: async () => {},
		});

		// `in` walks up to Object.prototype and would have answered "Object" here.
		expect(wrapped.constructor).toBe(inner.constructor);
		expect(wrapped.constructor.name).not.toBe("Object");
		await memory.flush();
	});

	test("options passed through query() are not double-wired", async () => {
		const spectron = new MockSpectron();
		let received: { hooks?: Record<string, unknown[]> } | undefined;

		const memory = createAgentMemory({
			client: spectron.asClient(),
			_queryFn: (params) => {
				received = params.options as typeof received;
				return scriptedQuery(ONE_TURN);
			},
		});

		await drain(
			memory.query({ prompt: "hi", options: memory.options({ model: "m" }) }),
		);

		expect(received?.hooks?.UserPromptSubmit).toHaveLength(1);
	});
});
