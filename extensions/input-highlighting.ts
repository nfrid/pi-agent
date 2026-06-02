import {
	CustomEditor,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const FG_CYAN = "\x1b[36m";
const FG_MAGENTA = "\x1b[35m";
const RESET_FG = "\x1b[39m";

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminals amiright?
const FILE_MENTION_RE = /(^|[\s([{])(@(?:"[^"]+"|[^\s\x1b\])}.,;:!?]+))/g;
const SLASH_COMMAND_RE = /(^|\s)(\/[a-zA-Z][a-zA-Z0-9_-]*)/g;

function highlightInputLine(line: string): string {
	return line
		.replace(FILE_MENTION_RE, `$1${FG_CYAN}$2${RESET_FG}`)
		.replace(SLASH_COMMAND_RE, `$1${FG_MAGENTA}$2${RESET_FG}`);
}

class HighlightEditor extends CustomEditor {
	render(width: number): string[] {
		return super.render(width).map(highlightInputLine);
	}
}

export default function inputHighlighting(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new HighlightEditor(tui, theme, keybindings),
		);
	});
}
