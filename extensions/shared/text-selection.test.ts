import { describe, expect, it } from 'vitest';
import { pageTextSelection, selectTextRange } from './text-selection';

describe('shared text selection', () => {
  it('selects heading sections and literal matching lines', () => {
    const source =
      '# Intro\nfirst\n## Details\nneedle 42\n### Child\nchild\n# End\nlast';
    expect(selectTextRange(source, { heading: 'Details' }).text).toBe(
      '## Details\nneedle 42\n### Child\nchild\n',
    );
    expect(selectTextRange(source, { heading: '## Details' }).text).toBe(
      '## Details\nneedle 42\n### Child\nchild\n',
    );
    expect(selectTextRange(source, { literal: 'needle' }).text).toBe(
      'needle 42',
    );
    expect(() =>
      selectTextRange(source, { literal: 'needle', heading: 'Details' }),
    ).toThrow('only one');
  });

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

  it('finds the same heading range from normalized titles', () => {
    const source = '# One\n## Target\nbody\n# End\n';
    const range = selectTextRange(source, { heading: 'Target' });
    expect(selectTextRange(source, { heading: '## Target' })).toEqual(range);
    expect(range.text).toBe('## Target\nbody\n');
  });
});
