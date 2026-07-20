import {
  CustomEditor,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { thinkingToThemeColor } from '../shared/theme';

const FG_CYAN = '\x1b[36m';
const FG_MAGENTA = '\x1b[35m';
const FG_YELLOW = '\x1b[33m';
const FG_BLUE = '\x1b[34m';
const FG_DIM = '\x1b[2m';
const RESET_FG = '\x1b[39m';
const RESET_DIM = '\x1b[22m';
const BOLD = '\x1b[1m';
const RESET_BOLD = '\x1b[22m';
const ITALIC = '\x1b[3m';
const RESET_ITALIC = '\x1b[23m';
const STRIKE = '\x1b[9m';
const RESET_STRIKE = '\x1b[29m';

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminals amiright?
const FILE_MENTION_RE = /(^|[\s([{])(@(?:"[^"]+"|[^\s\x1b\])}.,;:!?]+))/g;
const SLASH_COMMAND_RE = /(^|\s)(\/[a-zA-Z][a-zA-Z0-9_-]*)/g;
const CODE_SPAN_RE = /(`+)([^`\n]+?)\1/g;
const MARKDOWN_DELIMITERS = [
  {
    marker: '***',
    style: `${BOLD}${ITALIC}`,
    reset: `${RESET_ITALIC}${RESET_BOLD}`,
  },
  {
    marker: '___',
    style: `${BOLD}${ITALIC}`,
    reset: `${RESET_ITALIC}${RESET_BOLD}`,
  },
  { marker: '**', style: BOLD, reset: RESET_BOLD },
  { marker: '__', style: BOLD, reset: RESET_BOLD },
  { marker: '~~', style: STRIKE, reset: RESET_STRIKE },
  { marker: '*', style: ITALIC, reset: RESET_ITALIC },
  { marker: '_', style: ITALIC, reset: RESET_ITALIC },
];
const LINK_RE = /(\[[^\]\n]+\]\([^\s)]+\))/g;
const TODO_RE = /\b(TODO|FIXME|NOTE|HACK|BUG):?/g;
const HEADING_RE = /^(\s{0,3})(#{1,6}\s.+)$/;
const QUOTE_RE = /^(\s*>\s?)(.+)$/;
const LIST_RE = /^(\s*)([-*+] |\d+\. )(.*)$/;

function highlightMarkdownDelimiters(text: string): string {
  let result = '';
  let index = 0;

  while (index < text.length) {
    const delimiter = MARKDOWN_DELIMITERS.find(({ marker }) =>
      text.startsWith(marker, index),
    );

    if (!delimiter) {
      result += text[index];
      index++;
      continue;
    }

    const contentStart = index + delimiter.marker.length;
    const contentEnd = text.indexOf(delimiter.marker, contentStart);
    const content = contentEnd >= 0 ? text.slice(contentStart, contentEnd) : '';

    if (contentEnd < 0 || content.trim().length === 0) {
      result += text[index];
      index++;
      continue;
    }

    result += `${delimiter.style}${delimiter.marker}${content}${delimiter.marker}${delimiter.reset}`;
    index = contentEnd + delimiter.marker.length;
  }

  return result;
}

function highlightPlainTextChunk(text: string): string {
  const blockHighlighted = text
    .replace(HEADING_RE, `$1${BOLD}${FG_MAGENTA}$2${RESET_FG}${RESET_BOLD}`)
    .replace(QUOTE_RE, `${FG_DIM}$1$2${RESET_DIM}`)
    .replace(LIST_RE, `$1${FG_MAGENTA}$2${RESET_FG}$3`);

  return highlightMarkdownDelimiters(blockHighlighted)
    .replace(LINK_RE, `${FG_BLUE}$1${RESET_FG}`)
    .replace(FILE_MENTION_RE, `$1${FG_CYAN}$2${RESET_FG}`)
    .replace(SLASH_COMMAND_RE, `$1${FG_MAGENTA}$2${RESET_FG}`)
    .replace(TODO_RE, `${BOLD}${FG_YELLOW}$1${RESET_FG}${RESET_BOLD}`);
}

function highlightPlainText(text: string): string {
  let result = '';
  let lastIndex = 0;

  for (const match of text.matchAll(ANSI_RE)) {
    result += highlightPlainTextChunk(text.slice(lastIndex, match.index));
    result += match[0];
    lastIndex = match.index + match[0].length;
  }

  result += highlightPlainTextChunk(text.slice(lastIndex));
  return result;
}

function highlightInputLine(line: string): string {
  let lastIndex = 0;
  let highlighted = '';

  for (const match of line.matchAll(CODE_SPAN_RE)) {
    highlighted += highlightPlainText(line.slice(lastIndex, match.index));
    highlighted += `${FG_YELLOW}${match[0]}${RESET_FG}`;
    lastIndex = match.index + match[0].length;
  }

  highlighted += highlightPlainText(line.slice(lastIndex));
  return highlighted;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI/APC escapes
const ANSI_RE = /\x1b(?:\[[0-9;]*[A-Za-z]|_[\s\S]*?(?:\x07|\x1b\\))/g;

function isDefaultEditorBorder(line: string): boolean {
  return /^[─ ↑↓0-9more]+$/.test(line.replace(ANSI_RE, ''));
}

class HighlightEditor extends CustomEditor {
  private readonly dimBorder: (text: string) => string;
  private readonly thinkingBorder: (text: string) => string;

  constructor(
    args: ConstructorParameters<typeof CustomEditor>,
    thinkingBorder: (text: string) => string,
  ) {
    super(...args);

    this.dimBorder = args[1].borderColor;
    this.thinkingBorder = thinkingBorder;
    Object.defineProperty(this, 'borderColor', {
      configurable: true,
      get: () => this.dimBorder,
      set: () => undefined,
    });
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const lines = super.render(innerWidth).map(highlightInputLine);

    // The base editor renders horizontal rules above/below the input. Strip
    // those so our wrapper is the only box.
    if (lines[0] && isDefaultEditorBorder(lines[0])) lines.shift();
    let bottomIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (isDefaultEditorBorder(lines[i])) {
        bottomIndex = i;
        break;
      }
    }
    if (bottomIndex >= 0) lines.splice(bottomIndex, 1);

    const formatInner = (line: string) => {
      const truncated = truncateToWidth(line, innerWidth);
      return `${truncated}${' '.repeat(Math.max(0, innerWidth - visibleWidth(truncated)))}`;
    };

    return [
      `${this.thinkingBorder('┎')}${this.dimBorder(`${'─'.repeat(innerWidth)}┐`)}`,

      ...lines.map(
        (line) =>
          `${this.thinkingBorder('┃')}${formatInner(line)}${this.dimBorder('│')}`,
      ),
      `${this.thinkingBorder('┖')}${this.dimBorder(`${'─'.repeat(innerWidth)}┘`)}`,
    ];
  }
}

const registered = new WeakSet<object>();

export default function inputHighlighting(pi: ExtensionAPI) {
  if (registered.has(pi)) return;
  registered.add(pi);
  pi.on('session_start', (_event, ctx) => {
    const mode = 'mode' in ctx ? ctx.mode : 'tui';
    if (mode !== 'tui') return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const dimTheme = {
        ...theme,
        borderColor: (text: string) => ctx.ui.theme.fg('dim', text),
      };
      const thinkingBorder = (text: string) =>
        ctx.ui.theme.fg(thinkingToThemeColor(pi.getThinkingLevel()), text);

      return new HighlightEditor([tui, dimTheme, keybindings], thinkingBorder);
    });
  });
  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setEditorComponent(undefined);
  });
}
