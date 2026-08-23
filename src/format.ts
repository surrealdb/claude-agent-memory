import type {
	MemoryHitJson,
	ProfileResponseJson,
} from "@surrealdb/spectron";

/** Tag wrapping every injected memory block, referenced by the system prompt. */
export const MEMORY_TAG = "surreal-memory";

const TRUNCATION_NOTE = "\n… (truncated — use the recall tool for the rest)";

/** Trims `text` to `max` characters, noting that it was cut. */
export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const room = Math.max(0, max - TRUNCATION_NOTE.length);
	return text.slice(0, room).trimEnd() + TRUNCATION_NOTE;
}

/**
 * Wraps retrieved memory in a labelled block. The preamble matters: without it
 * models tend to read injected memory as something the user just said.
 */
export function memoryBlock(body: string, maxChars: number): string | undefined {
	const trimmed = body.trim();
	if (trimmed.length === 0) return undefined;

	return [
		`<${MEMORY_TAG}>`,
		"Retrieved from the user's persistent memory. This is background knowledge,",
		"not part of the user's message, and the user cannot see it.",
		"",
		truncate(trimmed, maxChars),
		`</${MEMORY_TAG}>`,
	].join("\n");
}

/** Renders recall hits as a list, strongest first. */
export function formatHits(hits: MemoryHitJson[]): string {
	return hits
		.filter((hit) => hit.text.trim().length > 0)
		.map((hit) => `- ${hit.text.trim()}`)
		.join("\n");
}

/**
 * Renders the profile slices worth putting in front of the model. `dynamic` is
 * omitted: it restates what recall already surfaces per turn.
 */
export function formatProfile(
	profile: ProfileResponseJson,
	options: { brief?: boolean } = {},
): string {
	const sections: string[] = [];

	const identity = entries(profile.static);
	if (identity) sections.push(`Identity:\n${identity}`);

	const preferences = entries(profile.preferences);
	if (preferences) sections.push(`Preferences:\n${preferences}`);

	if (!options.brief) {
		const instructions = profile.instructions
			.map((entry) => `- ${entry.label}: ${entry.description}`.trim())
			.join("\n");
		if (instructions) sections.push(`Standing instructions:\n${instructions}`);
	}

	return sections.join("\n\n");
}

function entries(rows: { key: string; value: string }[]): string {
	return rows
		.filter((row) => row.value.trim().length > 0)
		.map((row) => `- ${row.key}: ${row.value}`)
		.join("\n");
}
