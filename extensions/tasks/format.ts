import type { Theme } from "@earendil-works/pi-coding-agent";
import { MAX_REPLAY_CHARS, STATUS_GLYPH } from "./constants";
import { missingDeps, readyTasks, stats, unfinished } from "./queries";
import { getState } from "./state";
import type { Task } from "./types";

export function statusColor(
	task: Task,
): "dim" | "text" | "accent" | "warning" | "success" | "muted" {
	if (task.status === "blocked") return "warning";
	if (task.status === "doing") return "accent";
	if (task.status === "done") return "success";
	if (task.status === "dropped") return "muted";
	return "text";
}

export function formatTask(task: Task, includeDeps = true): string {
	const deps =
		includeDeps && task.dependsOn.length
			? ` deps=[${task.dependsOn.join(",")}]`
			: "";
	const priority =
		task.priority && task.priority !== "normal" ? ` !${task.priority}` : "";
	const note = task.notes ? ` — ${task.notes}` : "";
	return `${task.id} [${task.status}]${priority}${deps} ${task.text}${note}`;
}

export function formatVisualTask(
	task: Task,
	theme: Theme,
	opts: { showId?: boolean; showNotes?: boolean } = {},
): string {
	const glyph = theme.fg(statusColor(task), STATUS_GLYPH[task.status]);
	const id = opts.showId === false ? "" : ` ${theme.fg("accent", task.id)}`;
	let text = theme.fg(
		task.status === "done" || task.status === "dropped" ? "dim" : "text",
		task.text,
	);
	if (task.status === "done" || task.status === "dropped")
		text = theme.strikethrough(text);
	const deps = task.dependsOn.length
		? ` ${theme.fg("dim", `⛓ ${task.dependsOn.join(",")}`)}`
		: "";
	const priority =
		task.priority && task.priority !== "normal"
			? ` ${theme.fg(task.priority === "urgent" ? "error" : "warning", `!${task.priority}`)}`
			: "";
	const notes =
		opts.showNotes && task.notes
			? ` ${theme.fg("dim", `— ${task.notes}`)}`
			: "";
	return `${glyph}${id} ${text}${priority}${deps}${notes}`;
}

export function dashboard(includeDone = false, limit = 40): string {
	const visible = getState().tasks.filter((task) => includeDone || unfinished(task));
	if (!visible.length) return "No active tasks.";
	const ready = new Set(readyTasks().map((task) => task.id));
	const lines = visible.slice(0, limit).map((task) => {
		const blockedBy = missingDeps(task);
		const suffix = blockedBy.length
			? ` (waiting on ${blockedBy.join(", ")})`
			: ready.has(task.id)
				? " (ready)"
				: "";
		return `- ${formatTask(task)}${suffix}`;
	});
	if (visible.length > limit)
		lines.push(`- … ${visible.length - limit} more tasks omitted`);
	return lines.join("\n");
}

export function replayText(): string {
	const s = stats();
	let text = `Current todo state (${s.active} active, ${s.ready} ready, ${s.blocked} blocked, ${s.done} done).\n`;
	text +=
		"This replay is authoritative; it survives compaction/forking. Prefer updating it with the todo tool instead of free-form planning.\n";
	text += dashboard(false, 120);
	if (text.length > MAX_REPLAY_CHARS)
		text = `${text.slice(0, MAX_REPLAY_CHARS)}\n… todo replay truncated; use todo list include_done=false if needed.`;
	return text;
}
