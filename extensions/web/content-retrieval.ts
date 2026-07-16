import { createHash } from 'node:crypto';

export const DEFAULT_CONTENT_CHARS = 12_000;
export const MAX_CONTENT_CHARS = 100_000;

export interface ContentSelectors {
  heading?: string;
  literal?: string;
}

export interface ContentPage {
  text: string;
  details: {
    hash: string;
    totalChars: number;
    sourceTotalChars: number;
    selectedChars: number;
    offset: number;
    remainingChars: number;
    nextOffset: number | null;
    selectionStart: number;
    selectionEnd: number;
    selector?: 'heading' | 'literal';
  };
}

function lineRange(
  content: string,
  index: number,
  length: number,
): [number, number] {
  const start = content.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const next = content.indexOf('\n', index + length);
  return [start, next < 0 ? content.length : next];
}

function headingRange(
  content: string,
  wanted: string,
): [number, number] | null {
  const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
  let match = heading.exec(content);
  while (match) {
    if (match[2] === wanted) {
      const level = match[1].length;
      const start = match.index;
      const rest = content.slice(heading.lastIndex);
      const nextHeading = new RegExp(`^#{1,${level}}[ \\t]+`, 'm').exec(rest);
      const end = nextHeading
        ? heading.lastIndex + nextHeading.index
        : content.length;
      return [start, end];
    }
    match = heading.exec(content);
  }
  return null;
}

export function selectContent(
  content: string,
  selectors: ContentSelectors,
): {
  text: string;
  start: number;
  end: number;
  selector?: 'heading' | 'literal';
} {
  const supplied = [selectors.heading, selectors.literal].filter(
    (value) => value !== undefined,
  );
  if (supplied.length > 1)
    throw new Error('Use only one of heading or literal.');

  let range: [number, number] | null = null;
  let selector: 'heading' | 'literal' | undefined;
  if (selectors.heading !== undefined) {
    selector = 'heading';
    range = headingRange(content, selectors.heading);
  } else if (selectors.literal !== undefined) {
    selector = 'literal';
    const index = content.indexOf(selectors.literal);
    if (index >= 0) range = lineRange(content, index, selectors.literal.length);
  }

  if (selector && !range)
    throw new Error(`No content matched the ${selector} selector.`);
  const [start, end] = range ?? [0, content.length];
  return {
    text: content.slice(start, end),
    start,
    end,
    ...(selector ? { selector } : {}),
  };
}

function safeStart(text: string, offset: number): number {
  if (offset > 0 && offset < text.length) {
    const code = text.charCodeAt(offset);
    if (code >= 0xdc00 && code <= 0xdfff) return offset + 1;
  }
  return offset;
}

function safeEnd(text: string, start: number, proposed: number): number {
  if (proposed >= text.length) return text.length;
  const previous = text.charCodeAt(proposed - 1);
  if (previous >= 0xd800 && previous <= 0xdbff) {
    // A two-code-unit scalar must remain retrievable even when maxChars is 1.
    return proposed - 1 === start ? proposed + 1 : proposed - 1;
  }
  return proposed;
}

export function pageContent(
  content: string,
  options: ContentSelectors & { offset?: number; maxChars?: number } = {},
): ContentPage {
  const selection = selectContent(content, options);
  const requestedOffset = Math.max(0, Math.floor(options.offset ?? 0));
  const offset = safeStart(
    selection.text,
    Math.min(requestedOffset, selection.text.length),
  );
  const maxChars = Math.min(
    MAX_CONTENT_CHARS,
    Math.max(2, Math.floor(options.maxChars ?? DEFAULT_CONTENT_CHARS)),
  );
  const end = safeEnd(
    selection.text,
    offset,
    Math.min(selection.text.length, offset + maxChars),
  );
  const text = selection.text.slice(offset, end);
  const nextOffset = end < selection.text.length ? end : null;
  return {
    text,
    details: {
      hash: createHash('sha256').update(selection.text).digest('hex'),
      totalChars: selection.text.length,
      sourceTotalChars: content.length,
      selectedChars: text.length,
      offset,
      remainingChars: selection.text.length - end,
      nextOffset,
      selectionStart: selection.start,
      selectionEnd: selection.end,
      ...(selection.selector ? { selector: selection.selector } : {}),
    },
  };
}
