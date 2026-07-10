import { describe, expect, test } from "vitest";
import { resolveEffort } from "./config";
import { processJsonLine } from "./events";
import { truncateBytes } from "./output";
import { buildDelegatePrompt } from "./prompt";
import { buildChildArgs } from "./runner";
import { buildSessionSnapshotJsonl } from "./session";
import { createRun, getFinalAssistantText } from "./types";

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
		expect(prompt).toMatch(/read-only task/);
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

	test("snapshots the branch before the current delegate call and overrides cwd", () => {
		expect(
			buildSessionSnapshotJsonl(
				{
					getHeader: () => ({ type: "session", id: "abc", cwd: "/old" }),
					getBranch: () => [
						{ type: "message", id: "one" },
						{
							type: "message",
							id: "current",
							message: {
								role: "assistant",
								content: [{ type: "toolCall", id: "call-1" }],
							},
						},
					],
				},
				{ cwd: "/new", excludeToolCallId: "call-1" },
			),
		).toBe(
			'{"type":"session","id":"abc","cwd":"/new"}\n{"type":"message","id":"one"}\n',
		);
	});

	test("uses ephemeral, minimal, read-only children by default", () => {
		const args = buildChildArgs({ task: "inspect" });
		expect(args).toContain("--no-session");
		expect(args).toContain("--no-extensions");
		expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,grep,find,ls");
	});

	test("enables mutation tools only when explicitly requested", () => {
		const args = buildChildArgs({ task: "implement", allowWrites: true });
		expect(args[args.indexOf("--tools") + 1]).toContain("write");
		expect(args[args.indexOf("--tools") + 1]).toContain("bash");
	});

	test("joins all text blocks in the final assistant response", () => {
		expect(
			getFinalAssistantText([
				{
					...assistantMessage,
					content: [
						{ type: "text", text: "first" },
						{ type: "text", text: "second" },
					],
				} as never,
			]),
		).toBe("first\nsecond");
	});
});
