import type { Message } from "@earendil-works/pi-ai";
import type { DelegatedRun } from "./types";

const MAX_ACTIVITY_COUNT = 20;
const MAX_MESSAGE_COUNT = 100;
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 1000;

function truncate(text: string, max = MAX_PREVIEW_CHARS): string {
	if (text.length <= max) return text;
	return `… ${text.slice(text.length - max)}`;
}

function textFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const p = part as { type?: string; text?: unknown };
			if (p.type === "text" && typeof p.text === "string") return p.text;
			if (p.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

function resultPreview(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const result = value as {
		content?: unknown;
		text?: unknown;
		message?: unknown;
	};
	const content = textFromContent(result.content);
	if (content) return truncate(content);
	if (typeof result.text === "string") return truncate(result.text.trim());
	if (typeof result.message === "string")
		return truncate(result.message.trim());
	return "";
}

function inline(value: string, max = 80): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function pathValue(value: unknown, fallback = "."): string {
	return typeof value === "string" && value
		? value.replace(/^\/Users\/[^/]+/, "~")
		: fallback;
}

function toolLabel(name: string, args: unknown): string {
	if (!args || typeof args !== "object") return name;
	const a = args as Record<string, unknown>;
	switch (name) {
		case "bash":
			return `bash $ ${inline(typeof a.command === "string" ? a.command : "...")}`;
		case "read":
			return `read ${pathValue(a.path ?? a.file_path, "...")}`;
		case "write":
			return `write ${pathValue(a.path ?? a.file_path, "...")}`;
		case "edit":
			return `edit ${pathValue(a.path ?? a.file_path, "...")}`;
		case "ls":
			return `ls ${pathValue(a.path)}`;
		case "find":
			return `find ${inline(String(a.pattern ?? "*"))} in ${pathValue(a.path)}`;
		case "grep":
			return `grep ${inline(String(a.pattern ?? ""))} in ${pathValue(a.path)}`;
		default:
			return name;
	}
}

function upsertActivity(
	run: DelegatedRun,
	activity: {
		id?: string;
		type: "thinking" | "tool";
		label: string;
		status: "running" | "completed" | "error";
		latestText?: string;
	},
) {
	const existingIndex = activity.id
		? run.activities.findIndex((existing) => existing.id === activity.id)
		: -1;
	if (existingIndex >= 0) run.activities[existingIndex] = activity;
	else run.activities.push(activity);
	while (run.activities.length > MAX_ACTIVITY_COUNT) run.activities.shift();
}

function eventId(
	event: Record<string, unknown>,
	prefix: string,
): string | undefined {
	if (typeof event.toolCallId === "string")
		return `${prefix}:${event.toolCallId}`;
	const assistantMessageEvent = asRecord(event.assistantMessageEvent);
	const contentIndex = assistantMessageEvent?.contentIndex;
	if (typeof contentIndex === "number") return `${prefix}:${contentIndex}`;
	return undefined;
}

function messageBytes(messages: Message[]): number {
	return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

function addMessage(run: DelegatedRun, message: Message) {
	run.messages.push(message);
	while (
		run.messages.length > 1 &&
		(run.messages.length > MAX_MESSAGE_COUNT ||
			messageBytes(run.messages) > MAX_MESSAGE_BYTES)
	)
		run.messages.shift();
	updateMessageMetadata(run, message);
}

function updateMessageMetadata(run: DelegatedRun, message: Message) {
	if (message.role !== "assistant") return;
	const usage = message.usage;
	if (usage) {
		run.usage.input += usage.input || 0;
		run.usage.output += usage.output || 0;
		run.usage.cacheRead += usage.cacheRead || 0;
		run.usage.cacheWrite += usage.cacheWrite || 0;
		run.usage.contextTokens = usage.totalTokens || run.usage.contextTokens;
	}
	run.usage.turns++;
	if (message.stopReason) run.stopReason = message.stopReason;
	if (message.errorMessage) run.errorMessage = message.errorMessage;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

export function processJsonLine(line: string, run: DelegatedRun): boolean {
	if (!line.trim()) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return false;
	}
	const event = asRecord(parsed);
	if (!event) return false;

	switch (event.type) {
		case "message_end":
			if (event.message) {
				addMessage(run, event.message as Message);
				return true;
			}
			return false;
		case "agent_end":
			// message_end is authoritative. agent_end repeats those messages as
			// separately deserialized objects, so identity checks cannot deduplicate it.
			// Retain agent_end only as a fallback for unexpected streams without
			// message_end events.
			if (run.messages.length === 0 && Array.isArray(event.messages)) {
				for (const message of event.messages as Message[])
					addMessage(run, message);
				return run.messages.length > 0;
			}
			return false;
		case "tool_execution_start":
			upsertActivity(run, {
				id: eventId(event, "tool"),
				type: "tool",
				label: toolLabel(String(event.toolName || "tool"), event.args),
				status: "running",
			});
			return true;
		case "tool_execution_update":
			upsertActivity(run, {
				id: eventId(event, "tool"),
				type: "tool",
				label: toolLabel(String(event.toolName || "tool"), event.args),
				status: "running",
				latestText: resultPreview(event.partialResult),
			});
			return true;
		case "tool_execution_end":
			upsertActivity(run, {
				id: eventId(event, "tool"),
				type: "tool",
				label: toolLabel(String(event.toolName || "tool"), event.args),
				status: event.isError ? "error" : "completed",
				latestText: resultPreview(event.result),
			});
			return true;
		case "message_update": {
			const assistantMessageEvent = asRecord(event.assistantMessageEvent);
			if (assistantMessageEvent?.type === "thinking_start") {
				upsertActivity(run, {
					id: eventId(event, "thinking"),
					type: "thinking",
					label: "thinking",
					status: "running",
				});
				return true;
			}
			if (assistantMessageEvent?.type === "thinking_end") {
				upsertActivity(run, {
					id: eventId(event, "thinking"),
					type: "thinking",
					label: "thinking",
					status: "completed",
				});
				return true;
			}
			return false;
		}
		default:
			return false;
	}
}
