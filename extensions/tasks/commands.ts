import type {
	ExtensionAPI,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { replayText } from "./format";
import { findTask } from "./ids";
import { TodoOverlay } from "./overlay";
import { setLastCtx } from "./state";
import { pauseUiUpdates, resumeUiUpdates } from "./store";
import type { Task, TodoUiAction } from "./types";
import { applyMutation } from "./ui-widget";

const TODO_OVERLAY_OPTIONS: NonNullable<
	Parameters<ExtensionUIContext["custom"]>[1]
> = {
	overlay: true,
	overlayOptions: {
		width: "80%",
		minWidth: 60,
		maxHeight: "85%",
		anchor: "right-center",
		margin: 1,
	},
};

export function registerTodoCommands(pi: ExtensionAPI): void {
	pi.registerCommand("todo", {
		description: "Manage todos interactively",
		handler: async (_args, ctx) => {
			setLastCtx(ctx);
			if (!ctx.hasUI) {
				ctx.ui.notify(replayText(), "info");
				return;
			}

			while (true) {
				let action: TodoUiAction | undefined;
				pauseUiUpdates();
				try {
					action = await ctx.ui.custom<TodoUiAction>(
						(tui, theme, _kb, done) =>
							new TodoOverlay(theme, () => tui.requestRender(), done),
						TODO_OVERLAY_OPTIONS,
					);
				} finally {
					resumeUiUpdates();
				}
				if (!action || action.kind === "close") return;

				if (action.kind === "add") {
					const text = await ctx.ui.input("Add todo", "task text");
					if (text?.trim())
						applyMutation(pi, ctx, "add", { action: "add", text: text.trim() });
				} else if (action.kind === "edit") {
					const task = findTask(action.id);
					if (!task) continue;
					const text = await ctx.ui.input(`Edit ${task.id}`, task.text);
					if (text?.trim())
						applyMutation(pi, ctx, "update", {
							action: "update",
							id: task.id,
							text: text.trim(),
						});
				} else if (action.kind === "notes") {
					const task = findTask(action.id);
					if (!task) continue;
					const notes = await ctx.ui.input(
						`Notes for ${task.id}`,
						task.notes ?? "",
					);
					if (notes !== undefined)
						applyMutation(pi, ctx, "update", {
							action: "update",
							id: task.id,
							notes: notes.trim() || undefined,
						});
				} else if (action.kind === "deps") {
					const task = findTask(action.id);
					if (!task) continue;
					const deps = await ctx.ui.input(
						`Dependencies for ${task.id}`,
						task.dependsOn.join(","),
					);
					if (deps !== undefined) {
						const result = applyMutation(pi, ctx, "update", {
							action: "update",
							id: task.id,
							depends_on: deps.split(/[,\s]+/).filter(Boolean),
						});
						if (result.error) ctx.ui.notify(result.message, "error");
					}
				} else if (action.kind === "priority") {
					const task = findTask(action.id);
					if (!task) continue;
					const priority = await ctx.ui.select(`Priority for ${task.id}`, [
						"low",
						"normal",
						"high",
						"urgent",
					]);
					if (priority)
						applyMutation(pi, ctx, "update", {
							action: "update",
							id: task.id,
							priority: priority as Task["priority"],
						});
				} else if (action.kind === "status") {
					applyMutation(pi, ctx, "update", {
						action: "update",
						id: action.id,
						status: action.status,
					});
				} else if (action.kind === "remove") {
					const ok = await ctx.ui.confirm(
						`Remove ${action.id}?`,
						"This removes the task permanently. Use drop/done if you want to keep history.",
					);
					if (ok) {
						const result = applyMutation(pi, ctx, "remove", {
							action: "remove",
							id: action.id,
						});
						if (result.error) ctx.ui.notify(result.message, "error");
					}
				} else if (action.kind === "clear_done") {
					const result = applyMutation(pi, ctx, "clear_done", {
						action: "clear_done",
					});
					ctx.ui.notify(result.message, "info");
				}
			}
		},
	});

	pi.registerCommand("todump", {
		description: "Insert current todo replay into the editor",
		handler: async (_args, ctx) => ctx.ui.setEditorText(replayText()),
	});
}
