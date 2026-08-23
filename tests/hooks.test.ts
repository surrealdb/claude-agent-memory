import { describe, expect, test } from "bun:test";
import type {
	HookCallback,
	HookEvent,
	HookInput,
	SessionStartHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { ConnectionError } from "@surrealdb/spectron";
import { createAgentMemory } from "../src/memory";
import { MEMORY_TAG } from "../src/format";
import type { AgentMemoryConfig, MemoryOp } from "../src/types";
import { MockSpectron } from "./mocks/spectron";

function setup(config: Partial<AgentMemoryConfig> = {}) {
	const spectron = new MockSpectron();
	const memory = createAgentMemory({ client: spectron.asClient(), ...config });
	return { spectron, memory, hooks: memory.hooks() };
}

function callback(
	hooks: Partial<Record<HookEvent, { hooks: HookCallback[] }[]>>,
	event: HookEvent,
): HookCallback {
	const found = hooks[event]?.[0]?.hooks[0];
	if (!found) throw new Error(`no ${event} hook registered`);
	return found;
}

const base = {
	session_id: "claude-1",
	transcript_path: "/tmp/t.jsonl",
	cwd: "/tmp",
};

const promptInput = (prompt: string): HookInput =>
	({ ...base, hook_event_name: "UserPromptSubmit", prompt }) as HookInput;

const startInput = (source: SessionStartHookInput["source"]): HookInput =>
	({ ...base, hook_event_name: "SessionStart", source }) as HookInput;

const signal = { signal: new AbortController().signal };

const contextOf = (output: unknown) =>
	(output as { hookSpecificOutput?: { additionalContext?: string } })
		.hookSpecificOutput?.additionalContext;

describe("UserPromptSubmit", () => {
	test("injects a labelled memory block built from context", async () => {
		const { spectron, hooks } = setup();

		const output = await callback(hooks, "UserPromptSubmit")(
			promptInput("Where do I live?"),
			undefined,
			signal,
		);

		expect(spectron.callsFor("context")).toHaveLength(1);
		expect(contextOf(output)).toContain(`<${MEMORY_TAG}>`);
		expect(contextOf(output)).toContain("prefers dark mode");
	});

	test("uses recall when asked to, passing k and the lens", async () => {
		const { spectron, hooks } = setup({
			retrieval: "recall",
			k: 3,
			lens: "user/tobie",
		});

		const output = await callback(hooks, "UserPromptSubmit")(
			promptInput("Where do I live?"),
			undefined,
			signal,
		);

		expect(spectron.callsFor("recall")[0]?.args[1]).toMatchObject({
			k: 3,
			lens: "user/tobie",
		});
		expect(contextOf(output)).toContain("- Prefers dark mode");
	});

	test("injects nothing when memory comes back empty", async () => {
		const { spectron, hooks } = setup();
		spectron.contextText = "   ";

		const output = await callback(hooks, "UserPromptSubmit")(
			promptInput("anything"),
			undefined,
			signal,
		);

		expect(contextOf(output)).toBeUndefined();
		expect(output).toMatchObject({ continue: true });
	});

	test("skips the round trip for a blank prompt", async () => {
		const { spectron, hooks } = setup();

		await callback(hooks, "UserPromptSubmit")(promptInput("   "), undefined, signal);

		expect(spectron.calls).toHaveLength(0);
	});

	test("continues the turn when memory is down", async () => {
		const { spectron, hooks } = setup();
		spectron.failWith("context", new ConnectionError({ status: 0, title: "down" }));

		const output = await callback(hooks, "UserPromptSubmit")(
			promptInput("hello"),
			undefined,
			signal,
		);

		expect(output).toMatchObject({ continue: true });
		expect(contextOf(output)).toBeUndefined();
	});

	test("gives up on a slow memory service rather than stalling the turn", async () => {
		const { spectron, hooks } = setup({ injectTimeoutMs: 20 });
		spectron.delay("context", 500);

		const started = Date.now();
		const output = await callback(hooks, "UserPromptSubmit")(
			promptInput("hello"),
			undefined,
			signal,
		);

		expect(Date.now() - started).toBeLessThan(400);
		expect(contextOf(output)).toBeUndefined();
	});

	test("reports what it swallowed", async () => {
		const seen: MemoryOp[] = [];
		const { spectron, hooks } = setup({ onError: (_, op) => seen.push(op) });
		spectron.failWith("context", new Error("nope"));

		await callback(hooks, "UserPromptSubmit")(promptInput("hi"), undefined, signal);

		expect(seen).toEqual(["context"]);
	});

	test("propagates the failure when failing closed", async () => {
		const { spectron, hooks } = setup({ failOpen: false });
		spectron.failWith("context", new Error("nope"));

		const attempt = callback(hooks, "UserPromptSubmit")(
			promptInput("hi"),
			undefined,
			signal,
		);

		await expect(attempt).rejects.toThrow("nope");
	});

	test("is not registered when injection is off", () => {
		expect(setup({ injectHistory: false }).hooks.UserPromptSubmit).toBeUndefined();
	});
});

describe("SessionStart", () => {
	test("injects the profile on a fresh session", async () => {
		const { spectron, hooks } = setup();

		const output = await callback(hooks, "SessionStart")(
			startInput("startup"),
			undefined,
			signal,
		);

		expect(spectron.callsFor("profile")).toHaveLength(1);
		expect(contextOf(output)).toContain("name: Tobie");
		expect(contextOf(output)).toContain("Be brief");
	});

	test("re-injects briefly after a compaction", async () => {
		const { hooks } = setup();

		const output = await callback(hooks, "SessionStart")(
			startInput("compact"),
			undefined,
			signal,
		);

		expect(contextOf(output)).toContain("name: Tobie");
		expect(contextOf(output)).not.toContain("Be brief");
	});

	test.each(["resume", "fork"] as const)(
		"stays quiet on %s, where the transcript already has it",
		async (source) => {
			const { spectron, hooks } = setup();

			const output = await callback(hooks, "SessionStart")(
				startInput(source),
				undefined,
				signal,
			);

			expect(spectron.calls).toHaveLength(0);
			expect(contextOf(output)).toBeUndefined();
		},
	);

	test("injects nothing when there is no profile yet", async () => {
		const { spectron, hooks } = setup();
		spectron.profilePayload = {
			static: [],
			dynamic: [],
			preferences: [],
			instructions: [],
		};

		const output = await callback(hooks, "SessionStart")(
			startInput("startup"),
			undefined,
			signal,
		);

		expect(contextOf(output)).toBeUndefined();
	});

	test("is not registered when profile injection is off", () => {
		expect(setup({ injectProfile: false }).hooks.SessionStart).toBeUndefined();
	});
});

describe("durability hooks", () => {
	test("compaction and session end both drain pending writes", async () => {
		const { hooks } = setup();

		for (const event of ["PreCompact", "SessionEnd"] as const) {
			const output = await callback(hooks, event)(
				{ ...base, hook_event_name: event } as HookInput,
				undefined,
				signal,
			);
			expect(output).toMatchObject({ continue: true });
		}
	});

	test("are registered even with injection disabled", () => {
		const { hooks } = setup({ injectHistory: false, injectProfile: false });

		expect(hooks.PreCompact).toBeDefined();
		expect(hooks.SessionEnd).toBeDefined();
	});
});
