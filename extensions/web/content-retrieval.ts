import { createHash } from 'node:crypto';
import { pageTextSelection } from '../shared/text-selection';

export const DEFAULT_CONTENT_CHARS = 12_000;
export const MAX_CONTENT_CHARS = 100_000;

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
  };
}

export function pageContent(
  content: string,
  options: { offset?: number; maxChars?: number } = {},
): ContentPage {
  const maxChars = Math.min(
    MAX_CONTENT_CHARS,
    Math.max(2, Math.floor(options.maxChars ?? DEFAULT_CONTENT_CHARS)),
  );
  const page = pageTextSelection(content, {
    offset: options.offset,
    maxUnits: maxChars,
  });
  return {
    text: page.text,
    details: {
      hash: createHash('sha256').update(content).digest('hex'),
      totalChars: content.length,
      sourceTotalChars: content.length,
      selectedChars: page.text.length,
      offset: page.offset,
      remainingChars: content.length - page.end,
      nextOffset: page.nextOffset,
    },
  };
}
