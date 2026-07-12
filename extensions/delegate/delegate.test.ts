import { existsSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import {
	getAgentDir,
	initTheme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../system-prompt";
import { resolveEffort } from "./config";
import { processJsonLine } from "./events";
import { truncateBytes } from "./output";
import { buildDelegatePrompt } from "./prompt";
import { renderDelegateCall, renderDelegateResult } from "./render";
import { buildChildArgs } from "./runner";
import {
	buildSessionSnapshotJsonl,
	createDelegateSession,
	resolveDelegateSession,
} from "./session";
import { createRun, getFinalAssistantText, getRunState } from "./types";

initTheme("dark", false);

const theme = {
	fg: (_color: ThemeColor, text: string) => text,
	bold: (text: string) => text,
};

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

	test("adds curated context, advisory scope, and continuation framing", () => {
		const prompt = buildDelegatePrompt("Recheck the failure", {
			contextNote: "The parser path is already ruled out.",
			scope: ["src/cache", "tests/cache"],
			continuation: true,
		});
		expect(prompt).toContain("Context from the parent agent");
		expect(prompt).toContain("parser path is already ruled out");
		expect(prompt).toContain("guidance, not a hard boundary");
		expect(prompt).toContain("follow-up feedback");
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

	test("creates durable opaque sessions that can be resolved for continuation", () => {
		const session = createDelegateSession({ cwd: "/tmp/project" });
		try {
			expect(resolveDelegateSession(session.token)).toEqual(session);
			const header = JSON.parse(
				readFileSync(session.filePath, "utf8").trim(),
			) as Record<string, unknown>;
			expect(header).toMatchObject({
				type: "session",
				id: session.token,
				cwd: "/tmp/project",
			});
			expect(resolveDelegateSession("../../not-a-token")).toBeNull();
		} finally {
			const dir = path.join(getAgentDir(), "delegate-sessions");
			rmSync(path.join(dir, `${session.token}.jsonl`), { force: true });
			rmSync(path.join(dir, `${session.token}.json`), { force: true });
		}
	});

	test("uses persistent, minimal, read-only children with the system prompt extension", () => {
		const args = buildChildArgs({ task: "inspect" }, "/tmp/child.jsonl");
		expect(args).toContain("--session");
		expect(args[args.indexOf("--session") + 1]).toBe("/tmp/child.jsonl");
		expect(args).toContain("--no-extensions");
		const extensionPath = args[args.indexOf("--extension") + 1];
		expect(extensionPath).toMatch(/extensions[\\/]system-prompt\.ts$/);
		expect(existsSync(extensionPath)).toBe(true);
		expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,grep,find,ls");
	});

	test("gives delegate children a focused role without changing the main role", () => {
		const options = {
			cwd: "/tmp/project",
			selectedTools: ["read"],
			toolSnippets: { read: "Read files" },
		} as never;
		expect(buildSystemPrompt(options, "json", true)).toContain(
			"focused coding subagent",
		);
		expect(buildSystemPrompt(options, "tui", false)).toContain(
			"expert coding assistant",
		);
		expect(
			buildSystemPrompt(
				{
					cwd: "/tmp/project",
					customPrompt: "A carefully customized prompt",
				} as never,
				"json",
				true,
			),
		).toContain("Delegated child context");
	});

	test("enables mutation tools only when explicitly requested", () => {
		const args = buildChildArgs(
			{ task: "implement", allowWrites: true },
			"/tmp/child.jsonl",
		);
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

	test("tracks effective scope and lifecycle state", () => {
		const run = createRun("inspect", undefined, {
			cwd: "/tmp/project",
			context: "branch",
			allowWrites: true,
		});
		expect(run).toMatchObject({
			state: "queued",
			cwd: "/tmp/project",
			context: "branch",
			allowWrites: true,
		});
		expect(getRunState(run)).toBe("queued");
		expect(getRunState({ ...run, state: undefined, exitCode: 124 })).toBe(
			"timed-out",
		);
	});

	test("renders call scope badges with inherited parallel defaults", () => {
		const component = renderDelegateCall(
			{
				tasks: [
					{ task: "inspect" },
					{ task: "implement", allowWrites: true, context: "branch" },
				],
				cwd: "/tmp/project",
				context: "fresh",
			},
			theme,
			{ cwd: "/tmp/project" },
		);
		const output = component.render(300).join("\n");
		expect(output).toContain("inspect [fresh] [inspect] /tmp/project");
		expect(output).toContain("implement [branch] [writes] /tmp/project");
	});

	test("shows the full delegated prompt when the call is expanded", () => {
		const prompt = `Inspect the project and report ${"all relevant details ".repeat(20)}`;
		const component = renderDelegateCall({ task: prompt }, theme, {
			cwd: "/tmp/project",
			expanded: true,
		});
		expect(component.render(1000).join("\n")).toContain(prompt.trim());
	});

	test("preserves detailed tool labels when end events omit args", () => {
		const run = createRun("inspect");
		processJsonLine(
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "read-1",
				toolName: "read",
				args: { path: "/tmp/project/file.ts" },
			}),
			run,
		);
		processJsonLine(
			JSON.stringify({
				type: "tool_execution_end",
				toolCallId: "read-1",
				toolName: "read",
				result: { content: [{ type: "text", text: "contents" }] },
			}),
			run,
		);
		expect(run.activities[0]).toMatchObject({
			label: "read /tmp/project/file.ts",
			status: "completed",
		});
	});

	test("uses the first thinking text as an activity title", () => {
		const run = createRun("inspect");
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "I should inspect the type definitions first.",
				},
			}),
			run,
		);
		expect(run.activities[0]?.label).toBe(
			"thinking: I should inspect the type definitions first.",
		);
	});

	test("shows only a GPT-style bold thinking title", () => {
		const run = createRun("inspect");
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta:
						"**Thinking about oranges.**\n<!-- -->\nThe rest should stay hidden.",
				},
			}),
			run,
		);
		expect(run.activities[0]?.label).toBe("Thinking about oranges.");
	});

	test("dims tool metadata but not the tool name", () => {
		const run = createRun("inspect");
		run.state = "running";
		run.activities.push({
			type: "tool",
			label: "read /tmp/project/file.ts",
			status: "running",
		});
		const styledTheme = {
			fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => text,
		};
		const component = renderDelegateResult(
			{ details: { mode: "single", runs: [run] } },
			{ expanded: false },
			styledTheme,
		);
		const output = component.render(300).join("\n");
		expect(output).toContain("<toolOutput>read</toolOutput>");
		expect(output).toContain("<dim> /tmp/project/file.ts</dim>");
	});

	test("does not repeat a single task in the collapsed result", () => {
		const run = createRun("A unique delegated task", undefined, {
			cwd: "/tmp/project",
			context: "fresh",
		});
		run.state = "success";
		run.exitCode = 0;
		run.messages = [
			{
				...assistantMessage,
				content: [{ type: "text", text: "## Result\n\n- first\n- second" }],
			} as never,
		];
		run.finishedAt = Date.now();
		const component = renderDelegateResult(
			{ details: { mode: "single", runs: [run] } },
			{ expanded: false },
			theme,
		);
		const output = component.render(300).join("\n");
		expect(output).not.toContain("A unique delegated task");
		expect(output).toContain("Result");
		expect(output).toContain("first");
		expect(output).toContain("second");
	});

	test("renders partial parallel completion prominently", () => {
		const success = createRun("review", undefined, {
			cwd: "/tmp/project",
			context: "fresh",
		});
		success.state = "success";
		success.exitCode = 0;
		success.messages = [assistantMessage as never];
		success.finishedAt = Date.now();
		const failure = createRun("test", undefined, {
			cwd: "/tmp/project",
			context: "fresh",
		});
		failure.state = "error";
		failure.exitCode = 1;
		failure.errorMessage = "Tests failed";
		failure.finishedAt = Date.now();

		const component = renderDelegateResult(
			{ details: { mode: "parallel", runs: [success, failure] } },
			{ expanded: false },
			theme,
		);
		const output = component.render(300).join("\n");
		expect(output).toContain("1/2 succeeded");
		expect(output).toContain("Partial success");
		expect(output).toContain("Tests failed");
	});
});
