import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ResolvedConfig } from "./config";
import { guard, isAvailable } from "./guard";
import type { SessionBinder } from "./sessions";
import { TurnCapture, type CapturedTurn } from "./capture";
import type { QueryOverrides, TurnRecord } from "./types";

export interface WrapDeps {
	config: ResolvedConfig;
	binder: SessionBinder;
	overrides: QueryOverrides;
	/** Registers an in-flight write so it can be awaited later. */
	track: (write: Promise<unknown>) => void;
	/** Awaits every registered write. */
	flush: () => Promise<void>;
}

/**
 * Wraps a query so each exchange is written to memory as it completes.
 *
 * Every message is passed through untouched and in order. Writes start when a
 * turn closes but are not awaited there, so memory never adds latency to the
 * stream; they are awaited when the stream ends, so a query consumed to
 * completion leaves nothing unwritten.
 */
export function wrapQuery(inner: Query, deps: WrapDeps): Query {
	const capture = new TurnCapture();
	const storing = deps.overrides.store ?? deps.config.store;

	const onMessage = (message: SDKMessage) => {
		const turn = capture.observe(message);
		if (!turn) return;

		if (storing) {
			deps.track(persist(turn, deps));
		} else {
			report(deps, {
				claudeSessionId: turn.claudeSessionId,
				memorySessionId: deps.binder.sessionIdFor(
					turn.claudeSessionId,
					deps.overrides.sessionId,
				),
				messages: turn.messages,
				persisted: false,
			});
		}
	};

	let proxy: Query;

	const intercepted = {
		async next(...args: Parameters<Query["next"]>) {
			let result: IteratorResult<SDKMessage, void>;
			try {
				result = await inner.next(...args);
			} catch (error) {
				// A rejected `next()` ends `for await` without it calling `return()`,
				// so this is the last chance to land the turns already captured.
				await deps.flush();
				throw error;
			}

			if (result.done) await deps.flush();
			else onMessage(result.value);
			return result;
		},

		async return(value: void | PromiseLike<void>) {
			// A caller who stops early still gets the turns that had completed
			// before they walked away.
			try {
				return await inner.return(value as never);
			} finally {
				await deps.flush();
			}
		},

		async throw(error: unknown) {
			try {
				return await inner.throw(error);
			} finally {
				await deps.flush();
			}
		},

		[Symbol.asyncIterator]() {
			return proxy;
		},
	};

	// Everything else on Query — interrupt(), setModel(), async disposal, and
	// whatever the SDK adds next — belongs to the underlying query and is
	// delegated untouched.
	proxy = new Proxy(inner, {
		get(target, property) {
			// `hasOwn`, not `in`: the latter walks up to Object.prototype and would
			// answer for `constructor`, `toString`, and friends instead of letting
			// the real query answer for them.
			if (Object.hasOwn(intercepted, property)) {
				return Reflect.get(intercepted, property);
			}

			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Query;

	return proxy;
}

function persist(turn: CapturedTurn, deps: WrapDeps): Promise<void> {
	const { config, binder, overrides } = deps;
	const { claudeSessionId, messages } = turn;

	return binder.serialise(claudeSessionId, async () => {
		const scopes = overrides.scopes ?? config.scopes;

		// Read after the queue admits us: an earlier turn's write may have just
		// established the session this one should join.
		const sessionId = binder.sessionIdFor(claudeSessionId, overrides.sessionId);

		let failure: unknown;
		const result = await guard(
			config,
			"rememberMany",
			() =>
				config.client.rememberMany(messages, {
					...(sessionId === undefined ? {} : { sessionId }),
					...(scopes === undefined ? {} : { scopes }),
					...(config.extract === undefined ? {} : { extract: config.extract }),
					labels: binder.labelsFor(claudeSessionId, overrides.labels),
				}),
			{
				retryAfterMaxMs: 5000,
				timeoutMs: config.writeTimeoutMs,
				onFailure: (error) => {
					failure = error;
				},
			},
		);

		// The first write of a session is what creates it, so this is where the
		// binding for every later turn comes from.
		if (isAvailable(result) && binder.usesSessions(overrides.sessionId)) {
			binder.bind(claudeSessionId, result.sessionId);
		}

		report(deps, {
			claudeSessionId,
			memorySessionId: isAvailable(result) ? result.sessionId : sessionId,
			messages,
			persisted: isAvailable(result),
			...(failure === undefined ? {} : { error: failure }),
		});
	});
}

function report(deps: WrapDeps, record: TurnRecord): void {
	for (const listener of [deps.overrides.onTurn, deps.config.onTurn]) {
		try {
			listener?.(record);
		} catch {
			// An observer must not break the write path.
		}
	}
}
