export type TextSelectorKind = 'heading' | 'literal';

export interface TextSelectors {
  heading?: string;
  literal?: string;
}

export interface TextRange {
  text: string;
  start: number;
  end: number;
  selector?: TextSelectorKind;
}

export interface TextPageSlice {
  text: string;
  offset: number;
  end: number;
  nextOffset: number | null;
  selection: TextRange;
}

export function normalizeMarkdownHeadingTitle(value: string): string {
  return value
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/[ \t]*#+[ \t]*$/, '')
    .trim();
}

export function markdownHeadingRange(
  content: string,
  wanted: string,
): [number, number] | null {
  const normalized = normalizeMarkdownHeadingTitle(wanted);
  const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
  let match = heading.exec(content);
  while (match) {
    if (normalizeMarkdownHeadingTitle(match[2]) === normalized) {
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

export function literalLineRange(
  content: string,
  index: number,
  length: number,
): [number, number] {
  const start = content.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const next = content.indexOf('\n', index + length);
  return [start, next < 0 ? content.length : next];
}

export function selectTextRange(
  content: string,
  selectors: TextSelectors,
): TextRange {
  const supplied = [selectors.heading, selectors.literal].filter(
    (value) => value !== undefined,
  );
  if (supplied.length > 1)
    throw new Error('Use only one of heading or literal.');

  let range: [number, number] | null = null;
  let selector: TextSelectorKind | undefined;
  if (selectors.heading !== undefined) {
    selector = 'heading';
    range = markdownHeadingRange(content, selectors.heading);
  } else if (selectors.literal !== undefined) {
    selector = 'literal';
    const index = content.indexOf(selectors.literal);
    if (index >= 0)
      range = literalLineRange(content, index, selectors.literal.length);
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

/** Keep UTF-16 paging offsets on scalar boundaries. */
export function safeUtf16PageStart(text: string, offset: number): number {
  if (offset > 0 && offset < text.length) {
    const code = text.charCodeAt(offset);
    if (code >= 0xdc00 && code <= 0xdfff) return offset + 1;
  }
  return offset;
}

export function safeUtf16PageEnd(
  text: string,
  start: number,
  proposed: number,
): number {
  if (proposed >= text.length) return text.length;
  const previous = text.charCodeAt(proposed - 1);
  if (previous >= 0xd800 && previous <= 0xdbff) {
    // A two-code-unit scalar must remain retrievable even when maxUnits is 1.
    return proposed - 1 === start ? proposed + 1 : proposed - 1;
  }
  return proposed;
}

export function pageTextSelection(
  content: string,
  options: TextSelectors & { offset?: number; maxUnits?: number } = {},
): TextPageSlice {
  const selection = selectTextRange(content, options);
  const requestedOffset = Math.max(0, Math.floor(options.offset ?? 0));
  const offset = safeUtf16PageStart(
    selection.text,
    Math.min(requestedOffset, selection.text.length),
  );
  const maxUnits = Math.max(
    2,
    Math.floor(options.maxUnits ?? selection.text.length),
  );
  const end = safeUtf16PageEnd(
    selection.text,
    offset,
    Math.min(selection.text.length, offset + maxUnits),
  );
  const text = selection.text.slice(offset, end);
  return {
    text,
    offset,
    end,
    nextOffset: end < selection.text.length ? end : null,
    selection,
  };
}
