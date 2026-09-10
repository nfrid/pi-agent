import { describe, expect, it } from 'vitest';
import { pageTextSelection } from './text-selection';

describe('shared text paging', () => {
  it('pages UTF-16 text without splitting surrogate pairs', () => {
    const source = `${'abc😀'.repeat(7_000)}the end`;
    const chunks: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = pageTextSelection(source, { offset, maxUnits: 12_000 });
      expect(page.text).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(page.text).not.toMatch(/^[\uDC00-\uDFFF]/);
      chunks.push(page.text);
      offset = page.nextOffset;
    }
    expect(chunks.join('')).toBe(source);
  });
});
