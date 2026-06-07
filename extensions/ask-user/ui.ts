import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	matchesKey,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { PREVIEW_MARKER } from "./constants";
import { padToWidth } from "./format";
import type { AskUserParams } from "./schema";
import type { UiChoice, UiResult } from "./types";

type Done = (value: UiResult) => void;

function editorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

export function createQuestionDialog(
	params: AskUserParams,
	choices: UiChoice[],
	tui: TUI,
	theme: Theme,
	done: Done,
) {
	let selected = 0;
	let typing = choices.length === 0;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	const editor = new Editor(tui, editorTheme(theme));

	const refresh = () => {
		cachedWidth = undefined;
		cachedLines = undefined;
		tui.requestRender();
	};

	editor.onSubmit = (value) => {
		const answer = value.trim();
		if (answer) done({ answer, custom: true });
	};

	function handleInput(data: string): void {
		if (typing) {
			if (matchesKey(data, Key.escape)) {
				if (choices.length === 0) done(null);
				else {
					typing = false;
					editor.setText("");
					refresh();
				}
				return;
			}
			editor.handleInput(data);
			refresh();
			return;
		}

		if (matchesKey(data, Key.up)) {
			selected = Math.max(0, selected - 1);
			refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			selected = Math.min(choices.length - 1, selected + 1);
			refresh();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const choice = choices[selected];
			if (!choice) return;
			if (choice.custom) {
				typing = true;
				refresh();
				return;
			}
			done({
				answer: choice.value,
				choiceLabel: choice.label,
				choiceIndex: selected + 1,
				custom: false,
			});
			return;
		}
		if (matchesKey(data, Key.escape)) done(null);
	}

	function renderOptions(width: number): string[] {
		const out: string[] = [];
		const add = (text = "") => out.push(truncateToWidth(text, width));
		for (let i = 0; i < choices.length; i++) {
			const choice = choices[i];
			const isSelected = i === selected;
			const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
			const hasPreview = choice.preview
				? theme.fg("dim", ` ${PREVIEW_MARKER}`)
				: "";
			const label = `${i + 1}. ${choice.label}${choice.custom && typing ? " ✎" : ""}`;
			add(
				prefix + theme.fg(isSelected ? "accent" : "text", label) + hasPreview,
			);
			if (choice.description)
				add(`     ${theme.fg("muted", choice.description)}`);
		}
		return out;
	}

	function renderMarkdownPreview(
		preview: string,
		innerWidth: number,
	): string[] {
		return new Markdown(preview, 0, 0, getMarkdownTheme()).render(innerWidth);
	}

	function renderPreview(width: number): string[] {
		const choice = choices[selected];
		if (!choice?.preview || typing) return [];
		const innerWidth = Math.max(1, width - 4);
		const rendered = renderMarkdownPreview(choice.preview, innerWidth);
		const maxPreviewRows = 30;
		const body = rendered.slice(0, maxPreviewRows);
		const hidden = rendered.length - body.length;
		const rows = [theme.fg("accent", `╭${"─".repeat(innerWidth + 2)}╮`)];
		for (const line of body) {
			rows.push(
				theme.fg("accent", "│ ") +
					padToWidth(truncateToWidth(line, innerWidth, "…"), innerWidth) +
					theme.fg("accent", " │"),
			);
		}
		if (hidden > 0) {
			const more = theme.fg(
				"dim",
				`… ${hidden} more line${hidden === 1 ? "" : "s"}`,
			);
			rows.push(
				theme.fg("accent", "│ ") +
					padToWidth(more, innerWidth) +
					theme.fg("accent", " │"),
			);
		}
		rows.push(theme.fg("accent", `╰${"─".repeat(innerWidth + 2)}╯`));
		return rows.map((line) => truncateToWidth(line, width));
	}

	function render(width: number): string[] {
		if (cachedLines && cachedWidth === width) return cachedLines;
		const lines: string[] = [];
		const add = (text = "") => lines.push(truncateToWidth(text, width));
		const border = theme.fg("accent", "─".repeat(Math.max(0, width)));

		add(border);
		for (const line of wrapTextWithAnsi(
			theme.fg("text", params.question),
			Math.max(1, width - 2),
		))
			add(` ${line}`);
		add();

		if (choices.length > 0) {
			const preview = renderPreview(
				width >= 96 ? Math.floor(width * 0.48) : width - 2,
			);
			if (preview.length > 0 && width >= 96) {
				const leftWidth = Math.max(32, width - Math.floor(width * 0.48) - 3);
				const rightWidth = width - leftWidth - 3;
				const left = renderOptions(leftWidth);
				const right = renderPreview(rightWidth);
				const rows = Math.max(left.length, right.length);
				for (let i = 0; i < rows; i++) {
					const l = padToWidth(
						truncateToWidth(left[i] ?? "", leftWidth, ""),
						leftWidth,
					);
					add(`${l}   ${right[i] ?? ""}`);
				}
			} else {
				for (const line of renderOptions(width)) add(line);
				if (preview.length > 0) {
					add();
					for (const line of preview) add(` ${line}`);
				}
			}
			add();
		}

		if (typing) {
			add(theme.fg("muted", choices.length ? " Your answer:" : " Answer:"));
			for (const line of editor.render(Math.max(1, width - 2))) add(` ${line}`);
			add();
		}

		const help = typing
			? choices.length > 0
				? " Enter submit • Esc back"
				: " Enter submit • Esc cancel"
			: ` ↑↓ navigate • Enter select • Esc cancel • ${PREVIEW_MARKER} preview`;
		add(theme.fg("dim", help));
		add(border);

		cachedWidth = width;
		cachedLines = lines;
		return lines;
	}

	return { handleInput, invalidate: refresh, render };
}
