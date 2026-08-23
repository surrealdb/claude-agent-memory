import { describe, expect, test } from "bun:test";
import {
	MEMORY_TAG,
	formatHits,
	formatProfile,
	memoryBlock,
	truncate,
} from "../src/format";

describe("truncate", () => {
	test("leaves short text alone", () => {
		expect(truncate("short", 100)).toBe("short");
	});

	test("caps long text and says so", () => {
		const result = truncate("x".repeat(500), 100);

		expect(result.length).toBeLessThanOrEqual(100);
		expect(result).toContain("truncated");
	});
});

describe("memoryBlock", () => {
	test("labels the block and explains what it is", () => {
		const block = memoryBlock("Prefers dark mode", 4000);

		expect(block).toContain(`<${MEMORY_TAG}>`);
		expect(block).toContain(`</${MEMORY_TAG}>`);
		expect(block).toContain("Prefers dark mode");
		expect(block).toContain("not part of the user's message");
	});

	test("produces nothing for empty memory, rather than an empty block", () => {
		expect(memoryBlock("", 4000)).toBeUndefined();
		expect(memoryBlock("   \n  ", 4000)).toBeUndefined();
	});

	test("respects the character cap", () => {
		const block = memoryBlock("y".repeat(5000), 200);

		expect(block).toContain("truncated");
		expect(block?.length).toBeLessThan(600);
	});
});

describe("formatHits", () => {
	test("renders hits as a list and drops empty ones", () => {
		const body = formatHits([
			{ id: "1", score: 1, source: "fact", text: "Lives in Lisbon" },
			{ id: "2", score: 0.5, source: "fact", text: "   " },
			{ id: "3", score: 0.4, source: "fact", text: "Uses Bun" },
		] as never);

		expect(body).toBe("- Lives in Lisbon\n- Uses Bun");
	});
});

describe("formatProfile", () => {
	const profile = {
		static: [{ key: "name", value: "Tobie" }],
		dynamic: [{ key: "mood", value: "focused" }],
		preferences: [{ key: "theme", value: "dark" }],
		instructions: [
			{ id: "i1", label: "Be brief", description: "Prefers short answers" },
		],
	} as never;

	test("includes identity, preferences, and instructions", () => {
		const body = formatProfile(profile);

		expect(body).toContain("name: Tobie");
		expect(body).toContain("theme: dark");
		expect(body).toContain("Be brief");
	});

	test("omits the dynamic slice, which recall already covers per turn", () => {
		expect(formatProfile(profile)).not.toContain("focused");
	});

	test("brief mode drops standing instructions", () => {
		const body = formatProfile(profile, { brief: true });

		expect(body).toContain("name: Tobie");
		expect(body).not.toContain("Be brief");
	});

	test("returns nothing when there is no profile yet", () => {
		const empty = {
			static: [],
			dynamic: [],
			preferences: [],
			instructions: [],
		} as never;

		expect(formatProfile(empty)).toBe("");
	});
});
