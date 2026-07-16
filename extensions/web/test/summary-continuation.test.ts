import { describe, expect, it, vi } from 'vitest';

vi.mock('../search', () => ({
  search: vi.fn(async (query: string) => ({
    answer: `${query}:${'answer'.repeat(900)}`,
    results: [],
    provider: 'exa' as const,
  })),
}));

vi.mock('../extract', () => ({
  fetchAllContent: vi.fn(async (urls: string[]) =>
    urls.map((url) => ({ url, title: '', content: 'page', error: null })),
  ),
}));

import web from '../index';
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
  entries: StoredSearchData[];
} {
  const tools = new Map<string, { execute: Execute }>();
  const entries: StoredSearchData[] = [];
  web({
    on: vi.fn(),
    registerTool: vi.fn((tool: { name: string; execute: Execute }) =>
      tools.set(tool.name, tool),
    ),
    appendEntry: vi.fn((_type: string, data: StoredSearchData) =>
      entries.push(data),
    ),
  } as never);
  return { tools, entries };
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
  const match = notice.match(
    /responseId: "([^"]+)", view: "summary", offset: (\d+)/,
  );
  expect(match).not.toBeNull();
  const responseId = match?.[1] ?? '';
  const nextOffset = Number(match?.[2]);
  expect(responseId).toBe(String(initial.details.responseId));
  expect(nextOffset).toBe(initial.details.nextOffset);
  expect(rendered.length).toBeLessThanOrEqual(30_000);
  const continued = await getContent.execute(
    'continue',
    { responseId, view: 'summary', offset: nextOffset, maxChars: 100_000 },
    new AbortController().signal,
  );
  return prefix + continued.content[0].text;
}

describe('stored aggregate and summary continuation', () => {
  it('reconstructs the exact stored web_search aggregate from initial and continued text', async () => {
    const { tools, entries } = setup();
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
    expect(reconstructed).toBe(entries[0].summary);
    expect(initial.content[0].text).toContain('view: "summary"');
  });

  it('reconstructs the exact stored multi-URL summary from initial and continued text', async () => {
    const { tools, entries } = setup();
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
    expect(reconstructed).toBe(entries[0].summary);
    expect(initial.content[0].text).toContain('view: "summary"');
  });
});
