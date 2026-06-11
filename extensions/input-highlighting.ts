import {
	CustomEditor,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const FG_CYAN = "\x1b[36m";
const FG_MAGENTA = "\x1b[35m";
const FG_YELLOW = "\x1b[33m";
const FG_BLUE = "\x1b[34m";
const FG_DIM = "\x1b[2m";
const RESET_FG = "\x1b[39m";
const RESET_DIM = "\x1b[22m";
const BOLD = "\x1b[1m";
const RESET_BOLD = "\x1b[22m";
const ITALIC = "\x1b[3m";
const RESET_ITALIC = "\x1b[23m";
const STRIKE = "\x1b[9m";
const RESET_STRIKE = "\x1b[29m";

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminals amiright?
const FILE_MENTION_RE = /(^|[\s([{])(@(?:"[^"]+"|[^\s\x1b\])}.,;:!?]+))/g;
const SLASH_COMMAND_RE = /(^|\s)(\/[a-zA-Z][a-zA-Z0-9_-]*)/g;
const CODE_SPAN_RE = /(`+)([^`\n]+?)\1/g;
const BOLD_RE = /(\*\*|__)(\S(?:.*?\S)?)\1/g;
const ITALIC_RE = /(^|[^*_])([*_])(\S(?:[^*_\n]*?\S)?)\2/g;
const STRIKE_RE = /(~~)(\S(?:.*?\S)?)\1/g;
const LINK_RE = /(\[[^\]\n]+\]\([^\s)]+\))/g;
const TODO_RE = /\b(TODO|FIXME|NOTE|HACK|BUG):?/g;
const HEADING_RE = /^(\s{0,3})(#{1,6}\s.+)$/;
const QUOTE_RE = /^(\s*>\s?)(.+)$/;
const LIST_RE = /^(\s*)([-*+] |\d+\. )(.*)$/;

function highlightPlainText(text: string): string {
	return text
		.replace(HEADING_RE, `$1${BOLD}${FG_MAGENTA}$2${RESET_FG}${RESET_BOLD}`)
		.replace(QUOTE_RE, `${FG_DIM}$1$2${RESET_DIM}`)
		.replace(LIST_RE, `$1${FG_MAGENTA}$2${RESET_FG}$3`)
		.replace(BOLD_RE, `${BOLD}$2${RESET_BOLD}`)
		.replace(STRIKE_RE, `${STRIKE}$2${RESET_STRIKE}`)
		.replace(ITALIC_RE, `$1${ITALIC}$3${RESET_ITALIC}`)
		.replace(LINK_RE, `${FG_BLUE}$1${RESET_FG}`)
		.replace(FILE_MENTION_RE, `$1${FG_CYAN}$2${RESET_FG}`)
		.replace(SLASH_COMMAND_RE, `$1${FG_MAGENTA}$2${RESET_FG}`)
		.replace(TODO_RE, `${BOLD}${FG_YELLOW}$1${RESET_FG}${RESET_BOLD}`);
}

function highlightInputLine(line: string): string {
	let lastIndex = 0;
	let highlighted = "";

	for (const match of line.matchAll(CODE_SPAN_RE)) {
		highlighted += highlightPlainText(line.slice(lastIndex, match.index));
		highlighted += `${FG_YELLOW}${match[0]}${RESET_FG}`;
		lastIndex = match.index + match[0].length;
	}

	highlighted += highlightPlainText(line.slice(lastIndex));
	return highlighted;
}

class HighlightEditor extends CustomEditor {
	render(width: number): string[] {
		return super.render(width).map(highlightInputLine);
	}
}

export default function inputHighlighting(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const mode = "mode" in ctx ? ctx.mode : "tui";
		if (mode !== "tui") return;
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new HighlightEditor(tui, theme, keybindings),
		);
	});
}
