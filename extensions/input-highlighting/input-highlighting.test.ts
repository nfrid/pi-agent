import { describe, expect, it } from 'vitest';
import { highlightInputLine, isDefaultEditorBorder } from './index';

const ESC = '\x1b';
const RESET_FG = `${ESC}[39m`;
const FG_CYAN = `${ESC}[36m`;
const FG_MAGENTA = `${ESC}[35m`;
const FG_YELLOW = `${ESC}[33m`;
const BOLD = `${ESC}[1m`;

/** Strip every SGR sequence, leaving the text the user actually typed. */
function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('highlightInputLine', () => {
  // The invariant that matters most: highlighting is presentation only and must
  // never alter the underlying text.
  it.each([
    'plain text with no markup',
    'a @file/mention here',
    '/slash-command arg',
    'a `code span` inline',
    '**bold** and _italic_ and ~~struck~~',
    '# heading',
    '> quoted line',
    '- list item',
    'TODO: fix this',
    '[link](https://example.com)',
    'mixed **bold** with `code` and @file and /cmd',
    '',
  ])('preserves the literal text of %j', (line) => {
    expect(plain(highlightInputLine(line))).toBe(line);
  });

  it('colors a file mention', () => {
    expect(highlightInputLine('see @src/index.ts')).toContain(FG_CYAN);
  });

  it('colors a slash command', () => {
    expect(highlightInputLine('/help me')).toContain(FG_MAGENTA);
  });

  it('colors a code span', () => {
    expect(highlightInputLine('run `npm test` now')).toContain(FG_YELLOW);
  });

  it('emphasises TODO markers', () => {
    const out = highlightInputLine('TODO: refactor');
    expect(out).toContain(BOLD);
    expect(out).toContain(FG_YELLOW);
  });

  it('does not highlight markup inside a code span', () => {
    // The code span is styled as one unit, so the inner ** must not also be
    // treated as bold markup.
    const out = highlightInputLine('`**not bold**`');
    expect(plain(out)).toBe('`**not bold**`');
    expect(out).toContain(FG_YELLOW);
    expect(out).not.toContain(BOLD);
  });

  it('leaves an unterminated delimiter alone', () => {
    const line = 'this ** is not bold';
    expect(plain(highlightInputLine(line))).toBe(line);
    expect(highlightInputLine(line)).not.toContain(BOLD);
  });

  it('leaves empty delimiter pairs alone', () => {
    expect(highlightInputLine('****')).not.toContain(BOLD);
  });

  it('preserves pre-existing ANSI sequences in the input', () => {
    const line = `${FG_CYAN}already colored${RESET_FG} and **bold**`;
    const out = highlightInputLine(line);
    expect(out).toContain(`${FG_CYAN}already colored${RESET_FG}`);
    expect(plain(out)).toBe('already colored and **bold**');
  });
});

describe('isDefaultEditorBorder', () => {
  it('recognises the base editor rule', () => {
    expect(isDefaultEditorBorder('────────')).toBe(true);
    expect(isDefaultEditorBorder('──── 2 more ────')).toBe(true);
  });

  it('recognises a rule wrapped in ANSI codes', () => {
    expect(isDefaultEditorBorder(`${FG_CYAN}──────${RESET_FG}`)).toBe(true);
  });

  it('does not mistake user text for a border', () => {
    expect(isDefaultEditorBorder('hello')).toBe(false);
    expect(isDefaultEditorBorder('')).toBe(false);
  });
});
