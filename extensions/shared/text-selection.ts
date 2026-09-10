export interface TextRange {
  text: string;
  start: number;
  end: number;
}

export interface TextPageSlice {
  text: string;
  offset: number;
  end: number;
  nextOffset: number | null;
  selection: TextRange;
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
  options: { offset?: number; maxUnits?: number } = {},
): TextPageSlice {
  const selection: TextRange = { text: content, start: 0, end: content.length };
  const requestedOffset = Math.max(0, Math.floor(options.offset ?? 0));
  const offset = safeUtf16PageStart(
    content,
    Math.min(requestedOffset, content.length),
  );
  const maxUnits = Math.max(2, Math.floor(options.maxUnits ?? content.length));
  const end = safeUtf16PageEnd(
    content,
    offset,
    Math.min(content.length, offset + maxUnits),
  );
  return {
    text: content.slice(offset, end),
    offset,
    end,
    nextOffset: end < content.length ? end : null,
    selection,
  };
}
