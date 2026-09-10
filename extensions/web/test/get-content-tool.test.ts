import { describe, expect, it } from 'vitest';
import { createGetSearchContentTool } from '../get-content-tool';
import { createWebResultStore } from '../storage';

function setup(content: string) {
  const store = createWebResultStore();
  store.store('result', {
    id: 'result',
    type: 'fetch',
    timestamp: 1,
    urls: [],
    contents: [{ id: 'result:page:0', text: content }],
  });
  return createGetSearchContentTool(store);
}

const signal = new AbortController().signal;

function textOf(page: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const text = page.content[0].text;
  if (text === undefined) throw new Error('expected text content');
  return text;
}

describe('get_search_content pagination guidance', () => {
  it('shows the exact continuation offset without changing the page prefix', async () => {
    const content = 'a😀b🦄c';
    const tool = setup(content);
    const page = await tool.execute(
      'read',
      { contentId: 'result:page:0', maxChars: 3 },
      signal,
      undefined,
      {} as never,
    );
    const text = textOf(page);

    expect(text.startsWith('a😀')).toBe(true);
    expect(text.slice(0, page.details.selectedChars)).toBe('a😀');
    expect(page.details.offset).toBe(0);
    expect(page.details.selectedChars).toBe(3);
    expect(text).toContain('contentId: "result:page:0", offset: 3');
  });

  it('does not add a continuation notice to the final slice', async () => {
    const tool = setup('a😀b');
    const page = await tool.execute(
      'read',
      { contentId: 'result:page:0', offset: 3, maxChars: 100 },
      signal,
      undefined,
      {} as never,
    );

    expect(textOf(page)).toBe('b');
    expect(page.details.nextOffset).toBeNull();
    expect(textOf(page)).not.toContain('Content truncated');
  });

  it('reconstructs exact Unicode content from selected slices', async () => {
    const source = `${'😀ab🦄'.repeat(20)}the end`;
    const tool = setup(source);
    let offset = 0;
    let reconstructed = '';
    let pageCount = 0;

    while (true) {
      const page = await tool.execute(
        'read',
        { contentId: 'result:page:0', offset, maxChars: 7 },
        signal,
        undefined,
        {} as never,
      );
      const selected = textOf(page).slice(0, page.details.selectedChars);
      expect(selected.length).toBe(page.details.selectedChars);
      reconstructed += selected;
      pageCount += 1;
      if (page.details.nextOffset === null) break;
      expect(textOf(page)).toContain(`offset: ${page.details.nextOffset}`);
      offset = page.details.nextOffset;
    }

    expect(pageCount).toBeGreaterThan(1);
    expect(reconstructed).toBe(source);
  });
});
