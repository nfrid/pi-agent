import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { TOOL_NAME } from "./constants";
import { normalizeChoices, resultText } from "./format";
import { ParamsSchema } from "./schema";
import type { Answer, UiResult } from "./types";
import { createQuestionDialog } from "./ui";

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool<typeof ParamsSchema, Answer>({
		name: TOOL_NAME,
		label: "Ask User",
		description:
			"Ask the user a question and wait for their answer. Use for clarifying requirements or confirming a decision before proceeding.",
		promptSnippet:
			"Ask the user a question with optional choices, optional markdown previews, and a custom-answer field",
		promptGuidelines: [
			"Use ask_user_question when you genuinely need the user's input to continue; do not guess when a short question would resolve ambiguity.",
			"Keep ask_user_question questions concise and include clear choices when the likely answers are known.",
			"Add choice.preview markdown when code snippets, ASCII diagrams, mockups, or visual comparisons would help the user choose.",
			"Prefer dead-simple ASCII diagrams in choice.preview: avoid fancy borders unless they add clarity; use short labels, arrows, and whitespace to make the comparison easy to scan.",
		],
		parameters: ParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const mode = "mode" in ctx ? ctx.mode : "tui";
			if (mode !== "tui") {
				const details: Answer = {
					question: params.question,
					answer: null,
					custom: false,
					cancelled: true,
				};
				return {
					content: [
						{
							type: "text",
							text: "Cannot ask user: interactive TUI is not available.",
						},
					],
					details,
					isError: true,
				};
			}

			const choices = normalizeChoices(params);
			const result = await ctx.ui.custom<UiResult>(
				(tui, theme, _keybindings, done) =>
					createQuestionDialog(params, choices, tui, theme, done),
			);

			const details: Answer = result
				? {
						question: params.question,
						answer: result.answer,
						choiceLabel: result.choiceLabel,
						choiceIndex: result.choiceIndex,
						custom: result.custom,
						cancelled: false,
					}
				: {
						question: params.question,
						answer: null,
						custom: false,
						cancelled: true,
					};

			return {
				content: [{ type: "text", text: resultText(details) }],
				details,
			};
		},

		renderCall(args, theme) {
			const choices = Array.isArray(args.choices) ? args.choices : [];
			const suffix =
				choices.length > 0
					? theme.fg("dim", ` (${choices.length} choices)`)
					: theme.fg("dim", " (free-form)");
			return new Text(
				theme.fg("toolTitle", theme.bold("ask user ")) +
					theme.fg("muted", truncateToWidth(args.question, 72, "…")) +
					suffix,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details;
			if (!details) return new Text("", 0, 0);
			if (details.cancelled)
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			const answer = details.choiceLabel ?? details.answer ?? "";
			const prefix = details.choiceIndex ? `${details.choiceIndex}. ` : "";
			const mode = details.custom ? theme.fg("muted", "(typed) ") : "";
			return new Text(
				theme.fg("success", "✓ ") +
					mode +
					theme.fg("accent", `${prefix}${answer}`),
				0,
				0,
			);
		},
	});
}
