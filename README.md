# @surrealdb/claude-agent-memory

Persistent memory for agents built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), backed by [SurrealDB Agent Memory](https://surrealdb.com/docs/agent-memory).

Your agent forgets everything when a session ends. This wires it to a memory service that does not: facts, preferences, and decisions are extracted from each turn, and the relevant ones come back on the next prompt — in a later session, a later process, a later week.

```ts
import { createAgentMemory } from "@surrealdb/claude-agent-memory";

const memory = createAgentMemory();

for await (const message of memory.query({ prompt: "Where did we land on auth?" })) {
  // …
}
```

That is the whole integration. The prompt above is answered with what earlier sessions established, and this session's exchange is stored for the next one.

## Install

```bash
bun add @surrealdb/claude-agent-memory @anthropic-ai/claude-agent-sdk
```

The Agent SDK is a peer dependency, so you control its version.

Configure the connection with the standard Agent Memory variables:

```bash
SPECTRON_ENDPOINT=https://your-instance.surreal.cloud
SPECTRON_API_KEY=…
SPECTRON_CONTEXT=your-context
```

Or pass them directly — `createAgentMemory({ endpoint, apiKey, context })`. Either way, a missing setting throws at startup rather than leaving you with an agent that silently has no memory.

## Two ways to use it

The package gives you the same wiring at two levels. Pick by whether you want your `query()` call back.

| | `memory.query(…)` | `memory.options(…)` |
|---|---|---|
| Recall injected into each prompt | yes | yes |
| Profile injected at session start | yes | yes |
| Memory tools offered to the model | yes | yes |
| **Turns captured and stored automatically** | **yes** | no |
| You keep your own `query()` call | no | yes |

`memory.query()` is a drop-in wrapper: it merges the options for you, then watches the message stream and writes each exchange as it completes. Storage lives here because only the wrapper sees the assistant's replies.

`memory.options()` merges memory into options you already have, for when you call the SDK's `query()` yourself:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt,
  options: memory.options({ model: "claude-sonnet-4-5", maxTurns: 10 }),
})) { … }
```

It never overwrites your settings: your hooks run before ours, your other MCP servers stay, your `systemPrompt` is appended to rather than replaced (preset, string, or array alike), and applying it twice changes nothing. A name collision on the MCP server throws instead of clobbering — rename ours with `serverName`.

On this path nothing is stored automatically. Let the model save what matters with the `remember` tool, or write it yourself through `memory.client`.

## What the model sees

Retrieved memory arrives as a labelled block, which the system-prompt text teaches the model to read as background rather than as something the user just said:

```
<surreal-memory>
Retrieved from the user's persistent memory. This is background knowledge,
not part of the user's message, and the user cannot see it.

The user prefers Rust for systems work and has been migrating …
</surreal-memory>
```

Alongside that, these tools are exposed as `mcp__spectron__<name>`:

| Tool | What it does | Default |
|---|---|---|
| `recall` | Search memory for specific facts | on |
| `context` | A synthesized briefing on a topic | on |
| `remember` | Save something durable | on |
| `reflect` | Reason across memory for an insight | on |
| `profile` | Who the user is, and their standing preferences | on |
| `inspect` | One memory in full, with provenance | on |
| `forget` | Delete matching memories | **off** |

`forget` is destructive and irreversible with `purge`, so it is opt-in:

```ts
createAgentMemory({ tools: { include: ["forget"] } });
```

You can also pass an exact list (`tools: ["recall", "remember"]`), an exclusion (`tools: { exclude: ["inspect"] }`), or `false` for no tools at all.

## Configuration

```ts
const memory = createAgentMemory({
  // Connection — each falls back to its SPECTRON_* variable.
  endpoint, apiKey, context,
  client,              // bring your own Spectron client instead
  timeout, maxRetries, fetchImpl,

  // Scoping
  scopes: "user/tobie",       // DNF selector for writes
  lens: "user/tobie",         // DNF selector for reads
  labels: ["app=support"],    // key=value labels on every write

  // Sessions
  sessionId,           // pin an existing memory session, or false to skip
  onSession,           // called when a Claude session binds to a memory session

  // Behaviour
  injectHistory: true,     // recall on every prompt
  injectProfile: true,     // profile at session start
  store: true,             // persist turns from memory.query()
  k: 8,                    // hits to retrieve
  retrieval: "context",    // "context" (prose) or "recall" (a list of facts)
  maxInjectChars: 4000,    // cap on an injected block
  extract,                 // "per_message" or "whole_conversation"

  // Surface
  tools, serverName: "spectron", systemPrompt: true,

  // Resilience
  failOpen: true,          // an outage degrades the agent, never breaks it
  injectTimeoutMs: 3000,   // budget for a call on the turn's critical path
  writeTimeoutMs: 15_000,  // budget for persisting one turn
  onError, onTurn, debug,
});
```

Scopes and lenses take any of the documented shapes: `"team/eng"`, `["team/eng", "org/acme"]` (either), or `[["team/eng", "org/acme"]]` (both).

## Sessions

Each Claude session gets its own Agent Memory session. The first stored turn creates it and every later turn in that conversation reuses it, so binding costs no extra round trip. Every row is also labelled `claude_session=<id>`, which is what makes the association durable — a later process can find a conversation's turns by label without inheriting any in-process state.

To continue the same memory session in a new process, capture the pairing and hand it back:

```ts
const memory = createAgentMemory({
  onSession: ({ claudeSessionId, memorySessionId }) => save(claudeSessionId, memorySessionId),
});

// later, elsewhere
createAgentMemory({ sessionId: await load(claudeSessionId) });
```

Resumed and forked sessions skip the profile injection, since the transcript already carries it, and the transcript they replay is not re-captured — those turns are already in memory. After a compaction the profile goes back in, briefly, because the earlier copy was summarised away.

## When memory is down

Memory is an enhancement, so by default a failure costs you the enhancement and nothing else. Every call is guarded: injection that fails or overruns `injectTimeoutMs` contributes nothing to the turn, a failed tool call returns an error the model can read and work around, and a failed write is reported through `onError` and through `onTurn` (as `persisted: false` with the `error` attached) while the message stream carries on untouched. A rate limit with a short `Retry-After` is retried once, because waiting beats losing the write.

Set `failOpen: false` to have failures throw instead — useful in tests, or when a memory-less answer is worse than no answer. Injection then throws from the hook; a write failure surfaces where the write is awaited, which means from the end of the stream or from `flush()`. Tool calls stay fail-open regardless: the model needs a reply it can reason about.

Writes never block the stream. They start when a turn closes and are awaited when the stream ends — including when it ends by throwing — and before a compaction and at session end, so a consumed query leaves nothing unwritten. Call `memory.flush()` if you abandon a query some other way. Turns within one conversation are written in order, so a later turn can join the session the first one created; separate conversations write concurrently.

## Multi-tenancy

Build one memory per request, and let the service enforce the boundary:

```ts
const base = new Spectron({ endpoint, apiKey, context });

const memory = createAgentMemory({
  client: base.onBehalfOf(`principal:${userId}`),
  scopes: `user/${userId}`,
  lens: `user/${userId}`,
});
```

`onBehalfOf` requires the `manage` grant and puts the check on the server rather than in your code. Scopes and lenses narrow it further. See `examples/multi-tenant.ts`.

## API

`createAgentMemory(config?)` returns:

- **`options(base?)`** — `base` with memory merged in. Pure, and idempotent.
- **`query({ prompt, options? }, overrides?)`** — the SDK's query with memory wired in and turns captured. `overrides` accepts `sessionId`, `scopes`, `labels`, `store`, `injectHistory`, `k`, and `onTurn` for this call only. There is no per-call `lens`: a read lens should narrow the tools too, and those are built per instance — build one memory per tenant instead.
- **`mcpServer()`** — the in-process MCP server, to place yourself.
- **`toolNames()`** — the qualified tool names, for `allowedTools`.
- **`hooks()`** — the hooks, to compose yourself.
- **`systemPromptAppend()`** — the system-prompt text.
- **`memorySessionFor(claudeSessionId)`** — the bound memory session, if known.
- **`flush()`** — await every in-flight write.
- **`client`** — the underlying [`Spectron`](https://surrealdb.com/docs/agent-memory) client, for documents, entities, traces, and everything else the service offers.

## Examples

```bash
bun run examples/drop-in.ts "I moved to Lisbon"   # then ask "Where do I live?"
bun run examples/composable.ts
bun run examples/tools-only.ts
bun run examples/multi-tenant.ts
```

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```

The test suite needs no credentials. Most of it runs against a recording client double and a scripted message stream; `tests/integration.test.ts` additionally drives the real HTTP client against a local stub of the Agent Memory API, so the requests this package puts on the wire — paths, auth, scope normalisation, batch bodies — are covered too.

## License

Apache-2.0
