import {
	getMarkdownTheme,
	keyHint,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
	type DelegateDetails,
	type DelegatedRun,
	type DelegateRunState,
	getFinalAssistantText,
	getRunState,
} from "./types";

const COLLAPSED_ACTIVITY_COUNT = 8;
const TASK_PREVIEW_CHARS = 180;
const ACTIVITY_PREVIEW_CHARS = 280;
const FINAL_PREVIEW_CHARS = 700;
const FINAL_PREVIEW_LINES = 10;

type ThemeLike = {
	fg: (color: ThemeColor, text: string) => string;
	bold: (text: string) => string;
};

type ToolResultLike = {
	content?: unknown;
	details?: DelegateDetails;
};

type DelegateCallTask = {
	task?: unknown;
	effort?: unknown;
	cwd?: unknown;
	context?: unknown;
	allowWrites?: unknown;
};

type DelegateCallArgs = DelegateCallTask & {
	tasks?: DelegateCallTask[];
};

type RenderContextLike = { cwd?: string; expanded?: boolean };

function truncate(text: string, max: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function markdownPreview(text: string): string {
	const lines = text.trim().split("\n");
	let preview = lines.slice(0, FINAL_PREVIEW_LINES).join("\n");
	let truncated = lines.length > FINAL_PREVIEW_LINES;
	if (preview.length > FINAL_PREVIEW_CHARS) {
		preview = preview.slice(0, FINAL_PREVIEW_CHARS).trimEnd();
		truncated = true;
	}
	if (!truncated) return preview;
	if ((preview.match(/```/g)?.length ?? 0) % 2 === 1) preview += "\n```";
	return `${preview}\n\n…`;
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
	if (run.usage.cost) parts.push(`$${run.usage.cost.toFixed(4)}`);
	if (run.model) parts.push(run.model);
	return parts.join(" ");
}

function compactPath(value: unknown): string {
	if (typeof value !== "string" || !value) return ".";
	const home = process.env.HOME;
	return home && (value === home || value.startsWith(`${home}/`))
		? `~${value.slice(home.length)}`
		: value;
}

function scopeBadges(
	values: { context?: unknown; allowWrites?: unknown; cwd?: unknown },
	fg: (color: ThemeColor, text: string) => string,
): string {
	const context = values.context === "branch" ? "branch" : "fresh";
	const access = values.allowWrites === true ? "writes" : "inspect";
	return [
		fg("muted", `[${context}]`),
		fg(values.allowWrites === true ? "warning" : "muted", `[${access}]`),
		fg("dim", compactPath(values.cwd)),
	].join(" ");
}

function formatDuration(run: DelegatedRun): string {
	const start = run.startedAt ?? run.queuedAt;
	if (!start || !Number.isFinite(start)) return "";
	const end = run.finishedAt ?? Date.now();
	const milliseconds = Math.max(0, end - start);
	const seconds = Math.floor(milliseconds / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return minutes < 60
		? `${minutes}m ${remainder}s`
		: `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function stateLabel(run: DelegatedRun): string {
	const state = getRunState(run);
	const duration = formatDuration(run);
	const label =
		state === "success" ? "done" : state === "timed-out" ? "timed out" : state;
	return duration ? `${label} • ${duration}` : label;
}

function icon(
	run: DelegatedRun,
	fg: (color: ThemeColor, text: string) => string,
): string {
	const state = getRunState(run);
	if (state === "queued") return fg("muted", "○");
	if (state === "running") return fg("warning", "…");
	if (state === "error") return fg("error", "×");
	if (state === "aborted") return fg("warning", "−");
	if (state === "timed-out") return fg("warning", "◷");
	return fg("success", "✓");
}

function stateColor(state: DelegateRunState): ThemeColor {
	if (state === "success") return "success";
	if (state === "error") return "error";
	if (state === "running" || state === "aborted" || state === "timed-out")
		return "warning";
	return "muted";
}

function activityLabel(
	activity: DelegatedRun["activities"][number],
	fg: (color: ThemeColor, text: string) => string,
): string {
	if (activity.status === "error") return fg("error", activity.label);
	if (activity.type === "thinking") return fg("dim", activity.label);
	const separator = activity.label.indexOf(" ");
	if (separator < 0) return fg("toolOutput", activity.label);
	return `${fg("toolOutput", activity.label.slice(0, separator))}${fg("dim", activity.label.slice(separator))}`;
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
		lines.push(`${marker} ${activityLabel(activity, fg)}`);
		if (activity.latestText && expanded)
			lines.push(
				fg("dim", truncate(activity.latestText, ACTIVITY_PREVIEW_CHARS)),
			);
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

export function renderDelegateCall(
	args: DelegateCallArgs,
	theme: ThemeLike,
	context?: RenderContextLike,
) {
	const fg = theme.fg.bind(theme);
	const topLevelEffort =
		typeof args.effort === "string"
			? ` ${fg("muted", `[${args.effort}]`)}`
			: "";
	if (Array.isArray(args?.tasks) && args.tasks.length > 0) {
		let text = `${fg("toolTitle", theme.bold("delegate"))}${topLevelEffort} ${fg("accent", `${args.tasks.length} tasks`)}`;
		const visibleTasks = context?.expanded
			? args.tasks
			: args.tasks.slice(0, 3);
		for (const task of visibleTasks) {
			const taskEffort =
				typeof task?.effort === "string"
					? ` ${fg("muted", `[${task.effort}]`)}`
					: "";
			const scope = scopeBadges(
				{
					context: task.context ?? args.context,
					allowWrites: task.allowWrites ?? args.allowWrites,
					cwd: task.cwd ?? context?.cwd,
				},
				fg,
			);
			const prompt = String(task?.task || "...");
			text += `\n  ${fg("dim", context?.expanded ? prompt : truncate(prompt, TASK_PREVIEW_CHARS))}${taskEffort} ${scope}`;
		}
		if (!context?.expanded && args.tasks.length > 3)
			text += `\n  ${fg("muted", `... +${args.tasks.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	const scope = scopeBadges(
		{
			context: args.context,
			allowWrites: args.allowWrites,
			cwd: args.cwd ?? context?.cwd,
		},
		fg,
	);
	const prompt = String(args?.task || "...");
	return new Text(
		`${fg("toolTitle", theme.bold("delegate"))}${topLevelEffort} ${fg("dim", context?.expanded ? prompt : truncate(prompt, TASK_PREVIEW_CHARS))}\n  ${scope}`,
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
		const succeeded = details.runs.filter(
			(run) => getRunState(run) === "success",
		).length;
		const completed = details.runs.filter(
			(run) =>
				!(["queued", "running"] as DelegateRunState[]).includes(
					getRunState(run),
				),
		).length;
		const title =
			details.mode === "parallel"
				? `delegate ${succeeded}/${details.runs.length} succeeded • ${completed}/${details.runs.length} complete`
				: "delegate result";
		container.addChild(new Text(fg("toolTitle", theme.bold(title)), 0, 0));
		for (const run of details.runs) {
			container.addChild(new Spacer(1));
			const state = getRunState(run);
			container.addChild(
				new Text(
					details.mode === "parallel"
						? `${icon(run, fg)} ${fg("accent", truncate(run.task, TASK_PREVIEW_CHARS))} ${fg(stateColor(state), `[${stateLabel(run)}]`)}`
						: `${icon(run, fg)} ${fg(stateColor(state), stateLabel(run))}`,
					0,
					0,
				),
			);
			if (
				details.mode === "parallel" &&
				(run.context !== undefined ||
					run.allowWrites !== undefined ||
					run.cwd !== undefined)
			)
				container.addChild(
					new Text(
						fg(
							"muted",
							scopeBadges(
								{
									context: run.context,
									allowWrites: run.allowWrites,
									cwd: run.cwd,
								},
								(_color, text) => text,
							),
						),
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
			} else if (
				!(["queued", "running"] as DelegateRunState[]).includes(state)
			) {
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

	if (details.mode === "single") {
		const run = details.runs[0];
		const state = getRunState(run);
		const container = new Container();
		container.addChild(
			new Text(
				`${icon(run, fg)} ${fg(stateColor(state), stateLabel(run))}`,
				0,
				0,
			),
		);
		if (run.effort?.warning)
			container.addChild(new Text(fg("warning", run.effort.warning), 0, 0));
		const activities = activityLines(run, fg, false);
		if (activities) container.addChild(new Text(activities, 0, 0));
		if (["error", "aborted", "timed-out"].includes(state))
			container.addChild(
				new Text(
					fg(
						state === "error" ? "error" : "warning",
						truncate(
							run.errorMessage || run.stderr || stateLabel(run),
							ACTIVITY_PREVIEW_CHARS,
						),
					),
					0,
					0,
				),
			);
		const final = getFinalAssistantText(run.messages).trim();
		if (final) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(markdownPreview(final), 0, 0, mdTheme));
		}
		const footer = [usage(run), `(${keyHint("app.tools.expand", "to expand")})`]
			.filter(Boolean)
			.join("\n");
		container.addChild(new Text(fg("dim", footer), 0, 0));
		return container;
	}

	const states = details.runs.map(getRunState);
	const complete = states.filter(
		(state) => !(["queued", "running"] as DelegateRunState[]).includes(state),
	).length;
	const succeeded = states.filter((state) => state === "success").length;
	let text =
		details.mode === "parallel"
			? `${fg("toolTitle", theme.bold("delegate"))} ${fg(succeeded === details.runs.length ? "success" : complete === details.runs.length ? "warning" : "accent", `${succeeded}/${details.runs.length} succeeded`)} ${fg("muted", `• ${complete}/${details.runs.length} complete`)}`
			: "";
	if (
		details.mode === "parallel" &&
		complete === details.runs.length &&
		succeeded > 0 &&
		succeeded < details.runs.length
	)
		text += `\n${fg("warning", "Partial success — expand for complete results and diagnostics.")}`;

	for (const run of details.runs) {
		if (text) text += "\n";
		const state = getRunState(run);
		text += `${icon(run, fg)} ${fg("accent", truncate(run.task, TASK_PREVIEW_CHARS))} ${fg(stateColor(state), `[${stateLabel(run)}]`)}`;
		if (details.runs.length === 1) {
			if (
				run.context !== undefined ||
				run.allowWrites !== undefined ||
				run.cwd !== undefined
			)
				text += `\n${scopeBadges(
					{
						context: run.context,
						allowWrites: run.allowWrites,
						cwd: run.cwd,
					},
					fg,
				)}`;
			const effort = effortLabel(run);
			if (effort) text += ` ${fg("muted", `[${effort}]`)}`;
			if (run.effort?.warning) text += `\n${fg("warning", run.effort.warning)}`;
			const activities = activityLines(run, fg, false);
			if (activities) text += `\n${activities}`;
			const final = getFinalAssistantText(run.messages).trim();
			if (final) text += `\n${fg("toolOutput", truncate(final, 240))}`;
			const stats = usage(run);
			if (stats) text += `\n${fg("dim", stats)}`;
		}
		if (details.runs.length > 1 && ["queued", "running"].includes(state)) {
			const latest = run.activities.at(-1);
			if (latest)
				text += `\n  ${activityLabel(
					{ ...latest, label: truncate(latest.label, TASK_PREVIEW_CHARS) },
					fg,
				)}`;
			else
				text += `\n  ${fg("muted", state === "queued" ? "waiting for a slot" : "starting child")}`;
		}
		if (details.runs.length > 1 && run.effort?.warning)
			text += `\n  ${fg("warning", truncate(run.effort.warning, 240))}`;
		if (["error", "aborted", "timed-out"].includes(state))
			text += `\n  ${fg(state === "error" ? "error" : "warning", truncate(run.errorMessage || run.stderr || stateLabel(run), 240))}`;
	}
	text += `\n${fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
	return new Text(text, 0, 0);
}
