import { describe, expect, test } from "bun:test";
import { TurnCapture, extractText } from "../src/capture";
import {
	assistantText,
	assistantToolUse,
	errorResult,
	replayedUser,
	resultMessage,
	systemInit,
	toolResult,
	userText,
} from "./mocks/sdk";

/** Folds a whole script in, returning the turns it closed. */
function run(messages: Parameters<TurnCapture["observe"]>[0][]) {
	const capture = new TurnCapture();
	const turns = [];
	for (const message of messages) {
		const turn = capture.observe(message);
		if (turn) turns.push(turn);
	}
	return { capture, turns };
}

describe("extractText", () => {
	test("takes a plain string as is", () => {
		expect(extractText("hello " as never)).toBe("hello");
	});

	test("keeps text blocks and joins them", () => {
		const content = [
			{ type: "text", text: "one" },
			{ type: "text", text: "two" },
		] as never;

		expect(extractText(content)).toBe("one\n\ntwo");
	});

	test("drops thinking, tool calls, tool results, and images", () => {
		const content = [
			{ type: "thinking", thinking: "hmm" },
			{ type: "tool_use", id: "t", name: "Read", input: {} },
			{ type: "tool_result", tool_use_id: "t", content: "file body" },
			{ type: "image", source: {} },
			{ type: "text", text: "the answer" },
		] as never;

		expect(extractText(content)).toBe("the answer");
	});

	test("yields nothing when there is no prose", () => {
		expect(extractText([{ type: "tool_use", id: "t" }] as never)).toBe("");
	});
});

describe("TurnCapture", () => {
	test("captures one exchange, closed by the result message", () => {
		const { turns } = run([
			systemInit(),
			userText("I moved to Lisbon"),
			assistantText("Noted."),
			resultMessage(),
		]);

		expect(turns).toHaveLength(1);
		expect(turns[0]?.claudeSessionId).toBe("claude-session-1");
		expect(turns[0]?.messages).toEqual([
			{ role: "user", content: "I moved to Lisbon" },
			{ role: "assistant", content: "Noted." },
		]);
	});

	test("skips the agent talking to itself mid-loop", () => {
		const { turns } = run([
			systemInit(),
			userText("What is in my notes?"),
			assistantToolUse("Read"),
			toolResult("the file contents"),
			assistantText("Your notes mention Lisbon."),
			resultMessage(),
		]);

		expect(turns[0]?.messages).toEqual([
			{ role: "user", content: "What is in my notes?" },
			{ role: "assistant", content: "Your notes mention Lisbon." },
		]);
	});

	test("joins a reply that arrives as several assistant messages", () => {
		const { turns } = run([
			systemInit(),
			userText("Explain"),
			assistantText("First part."),
			assistantText("Second part."),
			resultMessage(),
		]);

		expect(turns[0]?.messages[1]).toEqual({
			role: "assistant",
			content: "First part.\n\nSecond part.",
		});
	});

	test("ignores synthetic user messages", () => {
		const { turns } = run([
			systemInit(),
			userText("real question"),
			userText("injected notice", { isSynthetic: true }),
			assistantText("answer"),
			resultMessage(),
		]);

		expect(turns[0]?.messages.filter((m) => m.role === "user")).toEqual([
			{ role: "user", content: "real question" },
		]);
	});

	test("ignores subagent traffic", () => {
		const { turns } = run([
			systemInit(),
			userText("delegate this"),
			assistantText("subagent chatter", { parentToolUseId: "tu_9" }),
			assistantText("worker output", { subagentType: "explorer" }),
			assistantText("Here is the summary."),
			resultMessage(),
		]);

		expect(turns[0]?.messages).toEqual([
			{ role: "user", content: "delegate this" },
			{ role: "assistant", content: "Here is the summary." },
		]);
	});

	test("does not count a replayed message twice", () => {
		const capture = new TurnCapture();
		const message = userText("hello");

		capture.observe(systemInit());
		capture.observe(message);
		capture.observe(message);
		capture.observe(assistantText("hi"));
		const turn = capture.observe(resultMessage());

		expect(turn?.messages.filter((m) => m.role === "user")).toHaveLength(1);
	});

	test("falls back to the result text when the stream had no assistant prose", () => {
		const { turns } = run([
			systemInit(),
			userText("ping"),
			resultMessage("pong"),
		]);

		expect(turns[0]?.messages).toEqual([
			{ role: "user", content: "ping" },
			{ role: "assistant", content: "pong" },
		]);
	});

	test("closes one turn per result across a multi-turn stream", () => {
		const { turns } = run([
			systemInit(),
			userText("first"),
			assistantText("one"),
			resultMessage(),
			userText("second"),
			assistantText("two"),
			resultMessage(),
		]);

		expect(turns).toHaveLength(2);
		expect(turns[1]?.messages).toEqual([
			{ role: "user", content: "second" },
			{ role: "assistant", content: "two" },
		]);
	});

	test("ignores the transcript replayed on resume", () => {
		const { turns } = run([
			systemInit(),
			replayedUser("Question from last week"),
			userText("today's question"),
			assistantText("today's answer"),
			resultMessage(),
		]);

		// Critically, the stale text must not be welded onto the live user message
		// by the same-role join.
		expect(turns[0]?.messages).toEqual([
			{ role: "user", content: "today's question" },
			{ role: "assistant", content: "today's answer" },
		]);
	});

	test("ignores a user message that does not start a turn", () => {
		const { turns } = run([
			systemInit(),
			userText("deferred note", { shouldQuery: false }),
			userText("the real prompt"),
			assistantText("answer"),
			resultMessage(),
		]);

		expect(turns[0]?.messages[0]).toEqual({
			role: "user",
			content: "the real prompt",
		});
	});

	test("never stores API error text as something the assistant said", () => {
		const { turns } = run([
			systemInit(),
			userText("hello"),
			errorResult("API Error: 500 overloaded"),
		]);

		// The user's half is still worth keeping; the error text is not a reply.
		expect(turns[0]?.messages).toEqual([{ role: "user", content: "hello" }]);
	});

	test("does not accumulate ids across turns", () => {
		const capture = new TurnCapture();
		capture.observe(systemInit());

		for (let turn = 0; turn < 50; turn += 1) {
			capture.observe(userText(`question ${turn}`));
			capture.observe(assistantText(`answer ${turn}`));
			capture.observe(resultMessage());
		}

		const tracked = (capture as unknown as { seen: Set<string> }).seen;
		expect(tracked.size).toBe(0);
	});

	test("closes nothing when a turn carried no prose at all", () => {
		const { turns } = run([systemInit(), assistantToolUse("Read"), resultMessage("")]);

		expect(turns).toHaveLength(0);
	});
});
