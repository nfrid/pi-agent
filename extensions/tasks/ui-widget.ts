import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { EXT, MAX_WIDGET_LINES } from "./constants";
import { mutate } from "./core";
import { formatVisualTask } from "./format";
import { stats } from "./queries";
import {
	getCompletedPendingHide,
	getHiddenCompleted,
	getLastCtx,
	getState,
	persist,
} from "./state";
import { uiUpdatesPaused } from "./store";
import type { Action, Params, Task } from "./types";

function visibleWidgetTasks(): Task[] {
	return getState().tasks.filter(
		(task) =>
			task.status !== "dropped" &&
			(task.status !== "done" || !getHiddenCompleted().has(task.id)),
	);
}

function markDisplayedCompleted(tasks: Task[]): void {
	const pending = getCompletedPendingHide();
	for (const task of tasks) {
		if (task.status === "done" && !getHiddenCompleted().has(task.id))
			pending.add(task.id);
	}
}

export function updateUi(ctx = getLastCtx()): void {
	if (uiUpdatesPaused() || !ctx?.hasUI) return;
	const s = stats();
	ctx.ui.setStatus(
		EXT,
		s.active
			? ctx.ui.theme.fg("accent", `todo ${s.done}/${s.total}`)
			: undefined,
	);
	if (
		!s.active &&
		getState().tasks.every(
			(task) => task.status !== "done" || getHiddenCompleted().has(task.id),
		)
	) {
		ctx.ui.setWidget(EXT, undefined);
		return;
	}
	ctx.ui.setWidget(EXT, (_tui, theme) => ({
		invalidate() {},
		render(width: number): string[] {
			const tasks = visibleWidgetTasks();
			if (!tasks.length) return [];
			const headingIcon = s.active
				? theme.fg("accent", "●")
				: theme.fg("dim", "○");
			const lines = [
				`${headingIcon} ${theme.fg(s.active ? "accent" : "dim", `Todos (${s.done}/${s.total})`)}`,
			];
			const visible = tasks.slice(0, MAX_WIDGET_LINES - 1);
			markDisplayedCompleted(visible);
			visible.forEach((task, index) => {
				const prefix =
					index === visible.length - 1 && tasks.length === visible.length
						? "└─"
						: "├─";
				lines.push(
					`${theme.fg("dim", prefix)} ${formatVisualTask(task, theme)}`,
				);
			});
			if (tasks.length > visible.length)
				lines.push(
					`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${tasks.length - visible.length} more`)}`,
				);
			return lines.map((line) => truncateToWidth(line, width, "…"));
		},
	}));
}

export function applyMutation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	action: Action,
	params: Params,
): { changed: boolean; message: string; error?: string } {
	const result = mutate(action, params);
	if (result.changed) persist(pi);
	updateUi(ctx);
	return result;
}
