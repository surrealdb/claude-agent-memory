import { describe, expect, test } from "bun:test";
import { CancelledError, RateLimitError } from "@surrealdb/spectron";
import { MEMORY_UNAVAILABLE, guard, isAvailable } from "../src/guard";
import type { MemoryOp } from "../src/types";

const open = { failOpen: true, onError: undefined, debug: false };
const closed = { failOpen: false, onError: undefined, debug: false };

const rateLimit = (retryAfter: number | null) =>
	new RateLimitError({ status: 429, title: "slow down", retryAfter });

describe("guard", () => {
	test("passes a value through", async () => {
		const result = await guard(open, "recall", async () => "hit");

		expect(isAvailable(result)).toBe(true);
		expect(result).toBe("hit");
	});

	test("swallows a failure when failing open", async () => {
		const seen: [unknown, MemoryOp][] = [];
		const config = {
			...open,
			onError: (error: unknown, op: MemoryOp) => seen.push([error, op]),
		};
		const boom = new Error("service down");

		const result = await guard(config, "context", async () => {
			throw boom;
		});

		expect(result).toBe(MEMORY_UNAVAILABLE);
		expect(seen).toEqual([[boom, "context"]]);
	});

	test("rethrows when failing closed", async () => {
		const attempt = guard(closed, "recall", async () => {
			throw new Error("service down");
		});

		await expect(attempt).rejects.toThrow("service down");
	});

	test("gives up on a call that overruns its budget", async () => {
		const result = await guard(
			open,
			"recall",
			() => new Promise((resolve) => setTimeout(() => resolve("late"), 200)),
			{ timeoutMs: 20 },
		);

		expect(result).toBe(MEMORY_UNAVAILABLE);
	});

	test("retries once when a rate limit asks for a short wait", async () => {
		let attempts = 0;
		const result = await guard(
			open,
			"rememberMany",
			async () => {
				attempts += 1;
				if (attempts === 1) throw rateLimit(0.01);
				return "stored";
			},
			{ retryAfterMaxMs: 5000 },
		);

		expect(attempts).toBe(2);
		expect(result).toBe("stored");
	});

	test("does not wait out a long rate limit", async () => {
		let attempts = 0;
		const result = await guard(
			open,
			"rememberMany",
			async () => {
				attempts += 1;
				throw rateLimit(600);
			},
			{ retryAfterMaxMs: 5000 },
		);

		expect(attempts).toBe(1);
		expect(result).toBe(MEMORY_UNAVAILABLE);
	});

	test("treats a caller's cancellation as intent, not a fault", async () => {
		const seen: MemoryOp[] = [];
		const config = { ...open, onError: (_: unknown, op: MemoryOp) => seen.push(op) };

		const result = await guard(config, "recall", async () => {
			throw new CancelledError({ status: 0, title: "aborted" });
		});

		expect(result).toBe(MEMORY_UNAVAILABLE);
		expect(seen).toEqual([]);
	});

	test("a throwing reporter does not become the failure", async () => {
		const config = {
			...open,
			onError: () => {
				throw new Error("reporter exploded");
			},
		};

		const result = await guard(config, "recall", async () => {
			throw new Error("service down");
		});

		expect(result).toBe(MEMORY_UNAVAILABLE);
	});
});
