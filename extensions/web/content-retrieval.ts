import { createHash } from 'node:crypto';
import {
  pageTextSelection,
  selectTextRange,
  type TextSelectors,
} from '../shared/text-selection';

export const DEFAULT_CONTENT_CHARS = 12_000;
export const MAX_CONTENT_CHARS = 100_000;

export type ContentSelectors = TextSelectors;

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

export const selectContent = selectTextRange;

export function pageContent(
  content: string,
  options: ContentSelectors & { offset?: number; maxChars?: number } = {},
): ContentPage {
  const maxChars = Math.min(
    MAX_CONTENT_CHARS,
    Math.max(2, Math.floor(options.maxChars ?? DEFAULT_CONTENT_CHARS)),
  );
  const page = pageTextSelection(content, {
    heading: options.heading,
    literal: options.literal,
    offset: options.offset,
    maxUnits: maxChars,
  });
  return {
    text: page.text,
    details: {
      hash: createHash('sha256').update(page.selection.text).digest('hex'),
      totalChars: page.selection.text.length,
      sourceTotalChars: content.length,
      selectedChars: page.text.length,
      offset: page.offset,
      remainingChars: page.selection.text.length - page.end,
      nextOffset: page.nextOffset,
      selectionStart: page.selection.start,
      selectionEnd: page.selection.end,
      ...(page.selection.selector ? { selector: page.selection.selector } : {}),
    },
  };
}
