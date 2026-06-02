import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { ACTION_GLYPH, EXT, TOOL } from "./constants";
import { mutate } from "./core";
import { dashboard, replayText } from "./format";
import { normalizeId } from "./ids";
import { stats } from "./queries";
import { paramsSchema } from "./schema";
import { persist, setLastCtx } from "./state";
import type { Params, ToolDetails } from "./types";
import { updateUi } from "./ui-widget";

export function registerTodoTool(pi: ExtensionAPI): void {
	pi.registerTool<typeof paramsSchema, ToolDetails>({
		name: TOOL,
		label: "Todo",
		description:
			"Single powerful todo/task tool with dependencies. Keep implementation plans here; update it whenever tasks change.",
		promptSnippet:
			"Manage the branch-local todo list with dependencies and statuses",
		promptGuidelines: [
			"Use todo for real multi-step work only; do not call todo for trivial one-shot questions or just to restate the user's request.",
			"Use todo batch to apply several independent task changes in one tool call; use replace only when rewriting the complete task set.",
			"Use todo start/done/block/drop at meaningful state changes; avoid list unless the replay/widget is insufficient or the user asks.",
			"When adding dependencies, make depends_on point to prerequisite task ids; keep task text short and put context in notes.",
		],
		parameters: paramsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			setLastCtx(ctx);
			let result: { changed: boolean; message: string; error?: string };
			if (params.action === "batch") {
				const operations = (params.operations ?? []) as Params[];
				if (!operations.length)
					result = {
						changed: false,
						message: "operations are required for batch",
						error: "operations are required for batch",
					};
				else {
					const messages: string[] = [];
					let changed = false;
					let error: string | undefined;
					for (const op of operations) {
						if (!op || op.action === "batch") {
							error = "batch operations must be non-batch todo actions";
							messages.push(error);
							break;
						}
						const step = mutate(op.action, op);
						changed ||= step.changed;
						messages.push(step.error ? `error: ${step.message}` : step.message);
						if (step.error) {
							error = step.error;
							break;
						}
					}
					result = { changed, message: messages.join("; "), error };
				}
			} else {
				result = mutate(params.action, params);
			}
			if (result.changed) persist(pi);
			updateUi(ctx);
			const details: ToolDetails = {
				action: params.action,
				changed: result.changed,
				message: result.message,
				stats: stats(),
				error: result.error,
			};
			const body = result.error
				? `Error: ${result.message}`
				: `${result.message}\n${dashboard(Boolean(params.include_done), 24)}`;
			return {
				content: [{ type: "text", text: body }],
				details,
				isError: Boolean(result.error),
			};
		},
		renderCall(args, theme) {
			const glyph = ACTION_GLYPH[args.action] ?? args.action;
			const id = args.id
				? ` ${theme.fg("accent", normalizeId(args.id) ?? args.id)}`
				: "";
			const text = args.text
				? ` ${theme.fg("dim", truncateToWidth(JSON.stringify(args.text), 48, "…"))}`
				: "";
			const count =
				args.action === "batch" && args.operations
					? ` ${theme.fg("dim", `${args.operations.length} ops`)}`
					: "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("todo "))}${theme.fg("muted", glyph)}${id}${text}${count}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details;
			if (!details) return new Text("", 0, 0);
			if (details.error)
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			const glyph = details.changed ? "✓" : "•";
			const color = details.changed ? "success" : "muted";
			return new Text(
				theme.fg(color, `${glyph} ${details.message}`) +
					theme.fg(
						"dim",
						` (${details.stats.active} active, ${details.stats.ready} ready)`,
					),
				0,
				0,
			);
		},
	});
}

export function registerTodoContext(pi: ExtensionAPI): void {
	pi.on("context", (event) => {
		let todoResultsLeft = 6;
		const messages = event.messages
			.map((message) => {
				if (message.role === "custom" && message.customType === `${EXT}-replay`)
					return undefined;
				if (message.role === "toolResult" && message.toolName === TOOL) {
					if (todoResultsLeft-- > 0) return message;
					return {
						...message,
						content: [
							{
								type: "text" as const,
								text: "[older todo tool result elided; current state is in the todo replay]",
							},
						],
					};
				}
				return message;
			})
			.filter((message): message is NonNullable<typeof message> =>
				Boolean(message),
			);
		messages.push({
			role: "custom" as const,
			customType: `${EXT}-replay`,
			content: replayText(),
			display: false,
			timestamp: Date.now(),
		});
		return { messages };
	});
}
