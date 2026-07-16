import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTENT_CHARS,
  MAX_CONTENT_CHARS,
  pageContent,
} from '../content-retrieval';

describe('bounded exact content retrieval', () => {
  it('reconstructs the exact stored UTF-16 text from next offsets', () => {
    const source = `${'abc😀'.repeat(7_000)}the end`;
    const chunks: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = pageContent(source, { offset });
      expect(page.text.length).toBeLessThanOrEqual(DEFAULT_CONTENT_CHARS);
      expect(page.text).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(page.text).not.toMatch(/^[\uDC00-\uDFFF]/);
      chunks.push(page.text);
      offset = page.details.nextOffset;
    }
    expect(chunks.join('')).toBe(source);
  });

  it('does not split emoji at either boundary and enforces the hard maximum', () => {
    const source = `a😀b${'x'.repeat(MAX_CONTENT_CHARS + 20)}`;
    const middle = pageContent(source, { offset: 2, maxChars: 2 });
    expect(middle.details.offset).toBe(3);
    expect(middle.text).toBe('bx');
    const bounded = pageContent(source, { maxChars: MAX_CONTENT_CHARS + 1 });
    expect(bounded.text.length).toBeLessThanOrEqual(MAX_CONTENT_CHARS);
  });

  it('selects heading sections and literal matching lines', () => {
    const source =
      '# Intro\nfirst\n## Details\nneedle 42\n### Child\nchild\n# End\nlast';
    expect(pageContent(source, { heading: 'Details' }).text).toBe(
      '## Details\nneedle 42\n### Child\nchild\n',
    );
    expect(pageContent(source, { literal: 'needle' }).text).toBe('needle 42');
    expect(() =>
      pageContent(source, { literal: 'needle', heading: 'Details' }),
    ).toThrow('only one');
  });

  it('reports stable paging metadata and a selection hash', () => {
    const first = pageContent('abcdef', { maxChars: 2 });
    const second = pageContent('abcdef', {
      offset: first.details.nextOffset ?? 0,
      maxChars: 2,
    });
    expect(first.details).toMatchObject({
      totalChars: 6,
      sourceTotalChars: 6,
      selectedChars: 2,
      remainingChars: 4,
      nextOffset: 2,
    });
    expect(second.details.hash).toBe(first.details.hash);
  });
});
