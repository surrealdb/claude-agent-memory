import { CancelledError, RateLimitError } from "@surrealdb/spectron";
import type { ResolvedConfig } from "./config";
import type { MemoryOp } from "./types";

/** Sentinel returned when a guarded call fails and `failOpen` is on. */
export const MEMORY_UNAVAILABLE = Symbol("memory-unavailable");

export type Guarded<T> = T | typeof MEMORY_UNAVAILABLE;

/** Narrows a guarded result to a value. */
export function isAvailable<T>(result: Guarded<T>): result is T {
	return result !== MEMORY_UNAVAILABLE;
}

class TimeoutError extends Error {
	constructor(op: MemoryOp, ms: number) {
		super(`memory op "${op}" exceeded ${ms}ms`);
		this.name = "MemoryTimeoutError";
	}
}

function withTimeout<T>(
	op: MemoryOp,
	ms: number | undefined,
	run: () => Promise<T>,
): Promise<T> {
	if (ms === undefined) return run();

	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new TimeoutError(op, ms)), ms);
		run().then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface GuardOptions {
	/** Abandon the call after this many ms. Omit for no deadline. */
	timeoutMs?: number;
	/** Retry once when the service asks us to wait no longer than this. */
	retryAfterMaxMs?: number;
	/**
	 * Receives the failure that was swallowed, for callers that need to report
	 * what went wrong rather than only that something did.
	 */
	onFailure?: (error: unknown) => void;
}

/**
 * Runs a memory call so that a failure degrades the agent instead of breaking
 * it. Returns {@link MEMORY_UNAVAILABLE} on failure when `failOpen` is on, and
 * rethrows otherwise.
 *
 * A rate limit with a short `Retry-After` is retried once, because the wait is
 * cheaper than losing the write. A caller-driven abort is not a fault, so it is
 * swallowed without reaching `onError`.
 */
export async function guard<T>(
	config: Pick<ResolvedConfig, "failOpen" | "onError" | "debug">,
	op: MemoryOp,
	run: () => Promise<T>,
	options: GuardOptions = {},
): Promise<Guarded<T>> {
	const started = Date.now();

	try {
		let result: T;
		try {
			result = await withTimeout(op, options.timeoutMs, run);
		} catch (error) {
			const retryAfterMs = retryDelay(error, options.retryAfterMaxMs);
			if (retryAfterMs === undefined) throw error;
			await sleep(retryAfterMs);
			result = await withTimeout(op, options.timeoutMs, run);
		}

		if (config.debug) {
			console.debug(`[claude-agent-memory] ${op} ok in ${Date.now() - started}ms`);
		}
		return result;
	} catch (error) {
		if (config.debug) {
			console.debug(
				`[claude-agent-memory] ${op} failed in ${Date.now() - started}ms: ${describe(error)}`,
			);
		}

		if (isAbort(error)) return MEMORY_UNAVAILABLE;

		try {
			options.onFailure?.(error);
		} catch {
			// A reporting callback must not become the failure itself.
		}

		if (!config.failOpen) throw error;

		try {
			config.onError?.(error, op);
		} catch {
			// Same again: reporting is never allowed to escalate.
		}
		return MEMORY_UNAVAILABLE;
	}
}

function retryDelay(error: unknown, maxMs: number | undefined): number | undefined {
	if (maxMs === undefined) return undefined;
	if (!(error instanceof RateLimitError)) return undefined;
	if (error.retryAfter === undefined) return undefined;

	const delayMs = error.retryAfter * 1000;
	return delayMs > 0 && delayMs <= maxMs ? delayMs : undefined;
}

function isAbort(error: unknown): boolean {
	if (error instanceof CancelledError) return true;
	return error instanceof Error && error.name === "AbortError";
}

/** A short, credential-free description of a failure. */
export function describe(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}
