import { afterEach, describe, expect, test } from "bun:test";
import { ALL_TOOLS, DEFAULT_TOOLS, resolveConfig } from "../src/config";
import { MockSpectron } from "./mocks/spectron";

const ENV_KEYS = [
	"SPECTRON_ENDPOINT",
	"SPECTRON_API_KEY",
	"SPECTRON_CONTEXT",
] as const;

const saved = new Map<string, string | undefined>();

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
	for (const key of ENV_KEYS) {
		if (!saved.has(key)) saved.set(key, process.env[key]);
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	saved.clear();
});

describe("connection", () => {
	test("reads the environment when nothing is passed", () => {
		setEnv({
			SPECTRON_ENDPOINT: "https://memory.example",
			SPECTRON_API_KEY: "key",
			SPECTRON_CONTEXT: "acme",
		});

		expect(resolveConfig().client.contextId).toBe("acme");
	});

	test("explicit values win over the environment", () => {
		setEnv({
			SPECTRON_ENDPOINT: "https://memory.example",
			SPECTRON_API_KEY: "key",
			SPECTRON_CONTEXT: "from-env",
		});

		expect(resolveConfig({ context: "explicit" }).client.contextId).toBe(
			"explicit",
		);
	});

	test("a supplied client wins over everything and needs no other config", () => {
		setEnv({});
		const client = new MockSpectron().asClient();

		expect(resolveConfig({ client }).client).toBe(client);
	});

	test("names every missing field rather than failing vaguely", () => {
		setEnv({ SPECTRON_ENDPOINT: "https://memory.example" });

		expect(() => resolveConfig()).toThrow(
			/missing apiKey \(SPECTRON_API_KEY\), context \(SPECTRON_CONTEXT\)/,
		);
	});
});

describe("tool selection", () => {
	const client = () => new MockSpectron().asClient();

	test("excludes the destructive tool by default", () => {
		expect(resolveConfig({ client: client() }).tools).toEqual([
			...DEFAULT_TOOLS,
		]);
		expect(resolveConfig({ client: client() }).tools).not.toContain("forget");
	});

	test("an array selects exactly those tools, in registration order", () => {
		expect(
			resolveConfig({ client: client(), tools: ["remember", "recall"] }).tools,
		).toEqual(["recall", "remember"]);
	});

	test("include adds to the default set", () => {
		expect(
			resolveConfig({ client: client(), tools: { include: ["forget"] } }).tools,
		).toEqual([...ALL_TOOLS]);
	});

	test("exclude removes from the default set", () => {
		const tools = resolveConfig({
			client: client(),
			tools: { exclude: ["inspect"] },
		}).tools;

		expect(tools).not.toContain("inspect");
		expect(tools).toContain("recall");
	});

	test("false selects none", () => {
		expect(resolveConfig({ client: client(), tools: false }).tools).toEqual([]);
	});
});

describe("defaults", () => {
	test("match the documented behaviour", () => {
		const config = resolveConfig({ client: new MockSpectron().asClient() });

		expect(config.injectHistory).toBe(true);
		expect(config.injectProfile).toBe(true);
		expect(config.store).toBe(true);
		expect(config.k).toBe(8);
		expect(config.retrieval).toBe("context");
		expect(config.maxInjectChars).toBe(4000);
		expect(config.serverName).toBe("spectron");
		expect(config.systemPrompt).toBe(true);
		expect(config.failOpen).toBe(true);
		expect(config.injectTimeoutMs).toBe(3000);
		expect(config.writeTimeoutMs).toBe(15_000);
	});
});
