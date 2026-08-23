/**
 * End-to-end coverage using the real Agent Memory HTTP client against a local
 * stub of the REST API. The other suites inject a client double, so this is
 * what checks that the requests we actually put on the wire are well-formed:
 * paths, auth, DNF scope normalisation, and the batch body.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config";
import { createAgentMemory } from "../src/memory";
import { buildTools } from "../src/tools";
import type { AgentMemory } from "../src/types";

type StubServer = ReturnType<typeof Bun.serve>;

interface Received {
	method: string;
	path: string;
	auth: string | null;
	body: Record<string, unknown> | null;
}

const SESSION = "claude-live-1";

let server: StubServer;
let endpoint: string;
let received: Received[];

/** Minimal stand-in for the endpoints this package calls. */
function startServer(): StubServer {
	return Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const raw = request.method === "GET" ? "" : await request.text();

			received.push({
				method: request.method,
				path: url.pathname,
				auth: request.headers.get("authorization"),
				body: raw ? JSON.parse(raw) : null,
			});

			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), {
					headers: { "content-type": "application/json" },
				});

			if (url.pathname.endsWith("/context")) {
				return json({
					context: "Prefers Rust. Lives in Lisbon.",
					queryMs: 3,
					tier: "t1",
				});
			}
			if (url.pathname.endsWith("/profile")) {
				return json({
					static: [{ key: "name", value: "Tobie" }],
					dynamic: [],
					preferences: [{ key: "language", value: "Rust" }],
					instructions: [],
				});
			}
			if (url.pathname.endsWith("/facts/batch")) {
				return json({ extractions: [], sessionId: "sess_abc", turnIds: ["t1"] });
			}
			return json({});
		},
	});
}

/** A scripted Claude stream, so no model is involved. */
function scriptedStream() {
	const message = (payload: object) => payload as never;
	const script = [
		message({
			type: "system",
			subtype: "init",
			session_id: SESSION,
			uuid: "u0",
			tools: [],
			mcp_servers: [],
		}),
		message({
			type: "user",
			message: { role: "user", content: [{ type: "text", text: "I prefer Rust" }] },
			parent_tool_use_id: null,
			uuid: "u1",
			session_id: SESSION,
		}),
		message({
			type: "assistant",
			message: {
				id: "m1",
				role: "assistant",
				content: [{ type: "text", text: "Noted — Rust it is." }],
			},
			parent_tool_use_id: null,
			uuid: "u2",
			session_id: SESSION,
		}),
		message({
			type: "result",
			subtype: "success",
			result: "Noted — Rust it is.",
			session_id: SESSION,
			uuid: "u3",
			is_error: false,
			num_turns: 1,
		}),
	];

	async function* generate() {
		for (const entry of script) yield entry;
	}
	const generator = generate();

	return {
		next: () => generator.next(),
		return: (value: never) => generator.return(value),
		throw: (error: never) => generator.throw(error),
		[Symbol.asyncIterator]() {
			return this;
		},
	} as never;
}

function memoryFor(): AgentMemory {
	return createAgentMemory({
		endpoint,
		apiKey: "test-key",
		context: "acme",
		scopes: "user/tobie",
		lens: "user/tobie",
		_queryFn: scriptedStream,
	});
}

const hookInput = (payload: object) => payload as never;
const signal = { signal: new AbortController().signal };
const contextOf = (output: unknown) =>
	(output as { hookSpecificOutput?: { additionalContext?: string } })
		?.hookSpecificOutput?.additionalContext ?? "";

const requestTo = (suffix: string) =>
	received.find((entry) => entry.path.endsWith(suffix));

beforeAll(() => {
	received = [];
	server = startServer();
	endpoint = `http://localhost:${server.port}`;
});

afterAll(() => {
	server.stop(true);
});

describe("over real HTTP", () => {
	test("injects retrieved memory into a prompt", async () => {
		const memory = memoryFor();
		const hook = memory.hooks().UserPromptSubmit?.[0]?.hooks[0];

		const output = await hook?.(
			hookInput({
				hook_event_name: "UserPromptSubmit",
				prompt: "What language do I prefer?",
				session_id: SESSION,
				transcript_path: "/tmp/t",
				cwd: "/tmp",
			}),
			undefined,
			signal,
		);

		expect(contextOf(output)).toContain("Lisbon");
		expect(contextOf(output)).toContain("<surreal-memory>");
		expect(requestTo("/context")?.path).toBe("/api/v1/acme/context");
	});

	test("sends the read lens in DNF form", () => {
		expect(requestTo("/context")?.body?.lens).toEqual([["user/tobie"]]);
	});

	test("injects the profile at session start", async () => {
		const memory = memoryFor();
		const hook = memory.hooks().SessionStart?.[0]?.hooks[0];

		const output = await hook?.(
			hookInput({
				hook_event_name: "SessionStart",
				source: "startup",
				session_id: SESSION,
				transcript_path: "/tmp/t",
				cwd: "/tmp",
			}),
			undefined,
			signal,
		);

		expect(contextOf(output)).toContain("Tobie");
		expect(requestTo("/profile")?.method).toBe("GET");
	});

	test("a tool handler reaches the service and renders the answer", async () => {
		const tools = buildTools(
			resolveConfig({
				endpoint,
				apiKey: "test-key",
				context: "acme",
				tools: ["context"],
			}),
		);

		const result = await tools[0]?.handler({ query: "language" } as never, undefined);

		expect(JSON.stringify(result)).toContain("Prefers Rust");
	});

	test("authenticates every request as a bearer token", () => {
		expect(received.length).toBeGreaterThan(0);
		expect(received.every((entry) => entry.auth === "Bearer test-key")).toBe(true);
	});

	test("persists a captured turn and binds the memory session", async () => {
		const memory = memoryFor();

		for await (const _ of memory.query({ prompt: "I prefer Rust" })) {
			// drain
		}

		const batch = requestTo("/facts/batch");
		expect(batch?.path).toBe("/api/v1/acme/facts/batch");
		expect(batch?.body?.messages).toEqual([
			{ role: "user", content: "I prefer Rust" },
			{ role: "assistant", content: "Noted — Rust it is." },
		]);
		expect(batch?.body?.scopes).toEqual([["user/tobie"]]);
		expect(batch?.body?.labels).toContain(`claude_session=${SESSION}`);

		// The session id comes back on the write, which is what later turns reuse.
		expect(memory.memorySessionFor(SESSION)).toBe("sess_abc");
	});
});
