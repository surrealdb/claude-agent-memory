import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: ["src/index.ts"],
	outdir: "dist",
	target: "node",
	format: "esm",
	sourcemap: "linked",
	external: ["@anthropic-ai/claude-agent-sdk", "@surrealdb/spectron", "zod"],
});

// A `sideEffects: false` in package.json makes this bundle tree-shake itself
// down to bare export names, so the field is deliberately absent. Guard against
// it coming back.
const bundle = await Bun.file("dist/index.js").text();
if (!bundle.includes("createAgentMemory")) {
	console.error(
		"dist/index.js is missing its implementation — check that package.json " +
			"has no sideEffects field.",
	);
	process.exit(1);
}

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

console.log(`built ${result.outputs.length} file(s) to dist/`);
