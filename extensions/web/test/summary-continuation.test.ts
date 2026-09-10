import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  payloads: [] as string[],
  searchResults: [] as Array<{
    title: string;
    url: string;
    snippet: string;
  }>,
}));
vi.mock('../../shared/cache-files', () => ({
  CACHE_FILE_MAX_BYTES: 16 * 1024 * 1024,
  writeCacheFile: vi.fn(async (input: string) => {
    state.payloads.push(input);
    return {
      path: `/tmp/${state.payloads.length}.json`,
      size: Buffer.byteLength(input),
    };
  }),
}));

vi.mock('../search', () => ({
  search: vi.fn(async (query: string) => ({
    answer: `${query}:${'answer'.repeat(900)}`,
    results: state.searchResults,
    provider: 'exa' as const,
  })),
}));

vi.mock('../extract', () => ({
  fetchAllContent: vi.fn(async (urls: string[]) =>
    urls.map((url, index) =>
      url.includes('/failed')
        ? { url, title: 'Failed page', content: '', error: 'unreadable' }
        : { url, title: `Title ${index}`, content: `page:${url}`, error: null },
    ),
  ),
}));

import web from '../index';
import { MAX_INLINE_CHARS } from '../result-support';
import type { StoredSearchData } from '../storage';

type ToolResult = {
  content: Array<{ text: string }>;
  details: Record<string, unknown>;
};
type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  onUpdate?: (update: unknown) => void,
  context?: unknown,
) => Promise<ToolResult>;

function setup(): {
  tools: Map<string, { execute: Execute }>;
  entries: unknown[];
} {
  const tools = new Map<string, { execute: Execute }>();
  const entries: unknown[] = [];
  state.payloads.length = 0;
  state.searchResults = [];
  web({
    on: vi.fn(),
    registerTool: vi.fn((tool: { name: string; execute: Execute }) =>
      tools.set(tool.name, tool),
    ),
    appendEntry: vi.fn((_type: string, data: unknown) => entries.push(data)),
  } as never);
  return { tools, entries };
}

function takeStoredPayload(): StoredSearchData {
  const payload = state.payloads.shift();
  if (!payload) throw new Error('cache file payload was not persisted');
  return JSON.parse(payload) as StoredSearchData;
}

async function reconstructInitialView(
  initial: ToolResult,
  getContent: { execute: Execute },
): Promise<string> {
  const rendered = initial.content[0].text;
  const marker = '\n\n[Content truncated:';
  const markerIndex = rendered.indexOf(marker);
  expect(markerIndex).toBeGreaterThan(0);
  const prefix = rendered.slice(0, markerIndex);
  const notice = rendered.slice(markerIndex + 2);
  const match = notice.match(/contentId: "([^"]+)", offset: (\d+)/);
  expect(match).not.toBeNull();
  const contentId = match?.[1] ?? '';
  const nextOffset = Number(match?.[2]);
  expect(nextOffset).toBe(initial.details.nextOffset);
  expect(rendered.length).toBeLessThanOrEqual(MAX_INLINE_CHARS + 3_000);
  const continued = await getContent.execute(
    'continue',
    {
      contentId,
      offset: nextOffset,
      maxChars: 100_000,
    },
    new AbortController().signal,
  );
  return prefix + continued.content[0].text;
}

describe('stored aggregate and summary continuation', () => {
  it('reconstructs the exact stored web_search aggregate from initial and continued text', async () => {
    const { tools } = setup();
    const searchTool = tools.get('web_search');
    const getContent = tools.get('get_search_content');
    if (!searchTool || !getContent) throw new Error('web tools not registered');
    const initial = await searchTool.execute(
      'search',
      { queries: Array.from({ length: 8 }, (_, index) => `query-${index}`) },
      new AbortController().signal,
      undefined,
      {},
    );
    const reconstructed = await reconstructInitialView(initial, getContent);
    expect(reconstructed).toBe(takeStoredPayload().summary);
    expect(initial.content[0].text).toContain('Content ID manifest:');
    expect(initial.content[0].text).toContain('Summary: ');
    expect(initial.content[0].text).not.toContain('Response ID:');
    expect(initial.content[0].text).toContain(
      'Full response file: /tmp/1.json',
    );
  });

  it('advertises and resolves visible search IDs for readable pages', async () => {
    const { tools } = setup();
    state.searchResults = [
      { title: 'Readable', url: 'https://one.test', snippet: '' },
      { title: 'Failed', url: 'https://failed.test/failed', snippet: '' },
    ];
    const searchTool = tools.get('web_search');
    const getContent = tools.get('get_search_content');
    if (!searchTool || !getContent) throw new Error('web tools not registered');
    const initial = await searchTool.execute(
      'search',
      { queries: ['visible research'], includeContent: true },
      new AbortController().signal,
      undefined,
      {},
    );
    const text = initial.content[0].text;
    const ids = [
      ...text.matchAll(/(?:Summary|Content ID|Page): ([^\s—]+)/g),
    ].map((match) => match[1]);
    expect(text).toContain('visible research');
    expect(text).toContain('Readable');
    expect(text).toContain('https://one.test');
    expect(text).toContain('https://failed.test/failed');
    expect(text).not.toContain('https://failed.test/failed — Content ID:');
    const summaryId = (initial.details.contentIds as { summary: string })
      .summary;
    expect(ids).toContain(summaryId);
    const aggregate = await getContent.execute(
      'read-summary',
      { contentId: summaryId },
      new AbortController().signal,
    );
    expect(aggregate.content[0].text).toContain('https://one.test');
    expect(ids.some((id) => id?.includes(':query:0'))).toBe(true);
    const pageId = ids.find((id) => id?.includes(':page:'));
    expect(pageId).toBeDefined();
    const page = await getContent.execute(
      'read',
      { contentId: pageId },
      new AbortController().signal,
    );
    expect(page.content[0].text).toBe('page:https://one.test');
    const queryId = ids.find((id) => id?.includes(':query:0'));
    expect(queryId).toBeDefined();
    const query = await getContent.execute(
      'read-query',
      { contentId: queryId },
      new AbortController().signal,
    );
    expect(query.content[0].text).toContain('https://one.test');
  });

  it('exposes a stable ID for a single readable page', async () => {
    const { tools } = setup();
    const fetchTool = tools.get('fetch_content');
    const getContent = tools.get('get_search_content');
    if (!fetchTool || !getContent) throw new Error('web tools not registered');
    const initial = await fetchTool.execute(
      'fetch',
      { urls: ['https://example.com/article'] },
      new AbortController().signal,
    );
    const contentId = String(initial.details.contentId);
    expect(contentId).toMatch(/:page:0$/);
    expect(initial.content[0].text).toContain(`Content ID: ${contentId}`);
    expect(initial.content[0].text).toContain('https://example.com/article');
    const page = await getContent.execute(
      'read',
      { contentId },
      new AbortController().signal,
    );
    expect(page.content[0].text).toBe('page:https://example.com/article');
  });

  it('advertises only successful page IDs for partial multi-fetches', async () => {
    const { tools } = setup();
    const fetchTool = tools.get('fetch_content');
    const getContent = tools.get('get_search_content');
    if (!fetchTool || !getContent) throw new Error('web tools not registered');
    const initial = await fetchTool.execute(
      'fetch',
      {
        urls: [
          'https://one.test',
          'https://failed.test/failed',
          'https://three.test',
        ],
      },
      new AbortController().signal,
    );
    const text = initial.content[0].text;
    const ids = [
      ...text.matchAll(/(?:Summary|Content ID|Page): ([^\s—]+)/g),
    ].map((match) => match[1]);
    expect(text).toMatch(/2\. Title 2[^\n]*\n\s+Content ID: [^\s]+:page:2/);
    expect(text).toContain('https://one.test');
    expect(text).toContain('https://failed.test/failed');
    expect(text).toContain('https://three.test');
    expect(ids.some((id) => id?.endsWith(':page:0'))).toBe(true);
    expect(ids.some((id) => id?.endsWith(':page:1'))).toBe(false);
    expect(ids.some((id) => id?.endsWith(':page:2'))).toBe(true);
    const summaryId = ids.find((id) => id?.endsWith(':summary'));
    expect(summaryId).toBeDefined();
    const aggregate = await getContent.execute(
      'read-summary',
      { contentId: summaryId },
      new AbortController().signal,
    );
    expect(aggregate.content[0].text).toContain('https://failed.test/failed');
    for (const pageId of ids.filter((id) => id?.includes(':page:'))) {
      const page = await getContent.execute(
        'read-page',
        { contentId: pageId },
        new AbortController().signal,
      );
      expect(page.content[0].text).toMatch(/page:https:\/\/(one|three)\.test/);
    }
  });

  it('reconstructs the exact stored multi-URL summary from initial and continued text', async () => {
    const { tools } = setup();
    const fetchTool = tools.get('fetch_content');
    const getContent = tools.get('get_search_content');
    if (!fetchTool || !getContent) throw new Error('web tools not registered');
    const urls = Array.from(
      { length: 10 },
      (_, index) => `https://example.com/${index}/${'x'.repeat(3_900)}`,
    );
    const initial = await fetchTool.execute(
      'fetch',
      { urls },
      new AbortController().signal,
    );
    const reconstructed = await reconstructInitialView(initial, getContent);
    expect(reconstructed).toBe(takeStoredPayload().summary);
    expect(initial.content[0].text).toContain('Content ID manifest:');
    expect(initial.content[0].text).not.toContain('Response ID:');
    expect(initial.content[0].text).toContain(
      'Full response file: /tmp/1.json',
    );
  });
});
