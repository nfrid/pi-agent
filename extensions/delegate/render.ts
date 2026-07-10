import {
	getMarkdownTheme,
	keyHint,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
	type DelegateDetails,
	type DelegatedRun,
	getFinalAssistantText,
	isRunError,
} from "./types";

const COLLAPSED_ACTIVITY_COUNT = 8;
const TASK_PREVIEW_CHARS = 96;

type ThemeLike = {
	fg: (color: ThemeColor, text: string) => string;
	bold: (text: string) => string;
};

type ToolResultLike = {
	content?: unknown;
	details?: DelegateDetails;
};

type DelegateCallArgs = {
	task?: unknown;
	effort?: unknown;
	tasks?: Array<{ task?: unknown; effort?: unknown }>;
};

function truncate(text: string, max: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function count(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function effortLabel(run: DelegatedRun): string {
	const effort = run.effort;
	if (!effort?.selected) return "";
	const profile = effort.profile;
	if (!profile)
		return effort.warning ? `${effort.selected} (default)` : effort.selected;
	return `${effort.selected}: ${effort.provider ?? "default"}/${profile.model} • ${profile.thinking}`;
}

function usage(run: DelegatedRun): string {
	const parts: string[] = [];
	if (run.usage.turns)
		parts.push(`${run.usage.turns} turn${run.usage.turns === 1 ? "" : "s"}`);
	if (run.usage.input) parts.push(`↑${count(run.usage.input)}`);
	if (run.usage.output) parts.push(`↓${count(run.usage.output)}`);
	if (run.usage.cacheRead) parts.push(`R${count(run.usage.cacheRead)}`);
	if (run.usage.cacheWrite) parts.push(`W${count(run.usage.cacheWrite)}`);
	if (run.usage.contextTokens)
		parts.push(`ctx:${count(run.usage.contextTokens)}`);
	return parts.join(" ");
}

function status(run: DelegatedRun): "running" | "success" | "error" {
	if (run.exitCode === -1) return "running";
	return isRunError(run) ? "error" : "success";
}

function icon(
	run: DelegatedRun,
	fg: (color: ThemeColor, text: string) => string,
): string {
	const state = status(run);
	if (state === "running") return fg("warning", "…");
	if (state === "error") return fg("error", "×");
	return fg("success", "✓");
}

function activityLines(
	run: DelegatedRun,
	fg: (color: ThemeColor, text: string) => string,
	expanded: boolean,
): string {
	const activities = expanded
		? run.activities
		: run.activities.slice(-COLLAPSED_ACTIVITY_COUNT);
	const skipped = run.activities.length - activities.length;
	const lines: string[] = [];
	if (skipped > 0)
		lines.push(
			fg(
				"muted",
				`... ${skipped} earlier activit${skipped === 1 ? "y" : "ies"}`,
			),
		);
	for (const activity of activities) {
		const marker =
			activity.status === "running"
				? fg("warning", "…")
				: activity.status === "error"
					? fg("error", "×")
					: fg("success", "✓");
		lines.push(
			`${marker} ${fg(activity.status === "error" ? "error" : "toolOutput", activity.label)}`,
		);
		if (activity.latestText && expanded)
			lines.push(fg("dim", activity.latestText));
	}
	return lines.join("\n");
}

function getDetails(toolResult: ToolResultLike): DelegateDetails | undefined {
	return toolResult.details;
}

function fallbackText(toolResult: ToolResultLike): string {
	const content = toolResult.content;
	if (!Array.isArray(content)) return "(no output)";
	const text = content.find((part): part is { type: "text"; text: string } => {
		if (!part || typeof part !== "object") return false;
		const candidate = part as { type?: unknown; text?: unknown };
		return candidate.type === "text" && typeof candidate.text === "string";
	});
	return text?.text || "(no output)";
}

export function renderDelegateCall(args: DelegateCallArgs, theme: ThemeLike) {
	const fg = theme.fg.bind(theme);
	const topLevelEffort =
		typeof args.effort === "string"
			? ` ${fg("muted", `[${args.effort}]`)}`
			: "";
	if (Array.isArray(args?.tasks) && args.tasks.length > 0) {
		let text = `${fg("toolTitle", theme.bold("delegate"))}${topLevelEffort} ${fg("accent", `${args.tasks.length} tasks`)}`;
		for (const task of args.tasks.slice(0, 3)) {
			const taskEffort =
				typeof task?.effort === "string"
					? ` ${fg("muted", `[${task.effort}]`)}`
					: "";
			text += `\n  ${fg("dim", truncate(String(task?.task || "..."), TASK_PREVIEW_CHARS))}${taskEffort}`;
		}
		if (args.tasks.length > 3)
			text += `\n  ${fg("muted", `... +${args.tasks.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	return new Text(
		`${fg("toolTitle", theme.bold("delegate"))}${topLevelEffort} ${fg("dim", truncate(String(args?.task || "..."), TASK_PREVIEW_CHARS))}`,
		0,
		0,
	);
}

export function renderDelegateResult(
	toolResult: ToolResultLike,
	{ expanded }: { expanded: boolean },
	theme: ThemeLike,
) {
	const details = getDetails(toolResult);
	if (!details?.runs?.length) return new Text(fallbackText(toolResult), 0, 0);

	const fg = theme.fg.bind(theme);
	const mdTheme = getMarkdownTheme();

	if (expanded) {
		const container = new Container();
		const title =
			details.mode === "parallel"
				? `delegate ${details.runs.filter((run) => run.exitCode !== -1).length}/${details.runs.length}`
				: "delegate";
		container.addChild(new Text(fg("toolTitle", theme.bold(title)), 0, 0));
		for (const run of details.runs) {
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					`${icon(run, fg)} ${fg("accent", truncate(run.task, TASK_PREVIEW_CHARS))}`,
					0,
					0,
				),
			);
			const effort = effortLabel(run);
			if (effort) container.addChild(new Text(fg("muted", effort), 0, 0));
			if (run.effort?.warning)
				container.addChild(new Text(fg("warning", run.effort.warning), 0, 0));
			const activities = activityLines(run, fg, true);
			if (activities) container.addChild(new Text(activities, 0, 0));
			const final = getFinalAssistantText(run.messages).trim();
			if (final) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(final, 0, 0, mdTheme));
			} else if (status(run) !== "running") {
				container.addChild(
					new Text(
						fg(
							"error",
							run.errorMessage || run.stderr.trim() || "No final response",
						),
						0,
						0,
					),
				);
			}
			const stats = usage(run);
			if (stats) container.addChild(new Text(fg("dim", stats), 0, 0));
		}
		return container;
	}

	let text = "";
	for (const run of details.runs) {
		if (text) text += "\n\n";
		text += `${icon(run, fg)} ${fg("accent", truncate(run.task, TASK_PREVIEW_CHARS))}`;
		const effort = effortLabel(run);
		if (effort) text += ` ${fg("muted", `[${effort}]`)}`;
		if (run.effort?.warning) text += `\n${fg("warning", run.effort.warning)}`;
		const activities = activityLines(run, fg, false);
		if (activities) text += `\n${activities}`;
		else if (status(run) === "running")
			text += `\n${fg("muted", "(running...)")}`;
		const final = getFinalAssistantText(run.messages).trim();
		if (final && details.runs.length === 1)
			text += `\n${fg("toolOutput", truncate(final, 240))}`;
		if (status(run) === "error")
			text += `\n${fg("error", truncate(run.errorMessage || run.stderr || "failed", 240))}`;
		const stats = usage(run);
		if (stats) text += `\n${fg("dim", stats)}`;
	}
	text += `\n${fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
	return new Text(text, 0, 0);
}
