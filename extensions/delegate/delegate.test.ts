import { describe, expect, test } from "vitest";
import { resolveEffort } from "./config";
import { processJsonLine } from "./events";
import { truncateBytes } from "./output";
import { buildDelegatePrompt } from "./prompt";
import { buildSessionSnapshotJsonl } from "./session";
import { createRun } from "./types";

const assistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "done" }],
	usage: {
		input: 10,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 12,
	},
};

describe("delegate", () => {
	test("defaults children to read-only work without a rigid report format", () => {
		const prompt = buildDelegatePrompt("Inspect the repository");
		expect(prompt).toMatch(/read-only by default/);
		expect(prompt).not.toMatch(/Use this exact structure/);
	});

	test("does not duplicate agent_end messages received through message_end", () => {
		const run = createRun("test");
		expect(
			processJsonLine(
				JSON.stringify({ type: "message_end", message: assistantMessage }),
				run,
			),
		).toBe(true);
		expect(
			processJsonLine(
				JSON.stringify({ type: "agent_end", messages: [assistantMessage] }),
				run,
			),
		).toBe(false);
		expect(run.messages).toHaveLength(1);
		expect(run.usage.turns).toBe(1);
	});

	test("uses agent_end as a fallback when message_end events are absent", () => {
		const run = createRun("test");
		expect(
			processJsonLine(
				JSON.stringify({ type: "agent_end", messages: [assistantMessage] }),
				run,
			),
		).toBe(true);
		expect(run.messages).toHaveLength(1);
		expect(run.usage.turns).toBe(1);
	});

	test("uses one configured provider for effort profiles", () => {
		expect(
			resolveEffort("fast", {
				provider: "openai-codex",
				effortProfiles: {
					fast: { model: "quick", thinking: "medium" },
				},
			}),
		).toEqual({
			selected: "fast",
			provider: "openai-codex",
			profile: { model: "quick", thinking: "medium" },
		});
		expect(resolveEffort("deep", { provider: "openai-codex" }).error).toMatch(
			/not fully configured/,
		);
	});

	test("caps parent-visible output by UTF-8 bytes", () => {
		const output = truncateBytes("🙂".repeat(100), 100);
		expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(100);
		expect(output).toMatch(/Output truncated/);
	});

	test("preserves the session header and current branch", () => {
		expect(
			buildSessionSnapshotJsonl({
				getHeader: () => ({ type: "session", id: "abc" }),
				getBranch: () => [{ type: "message", id: "one" }],
			}),
		).toBe('{"type":"session","id":"abc"}\n{"type":"message","id":"one"}\n');
	});
});
