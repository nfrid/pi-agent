import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ active: 0, peak: 0 }));
vi.mock('../search', () => ({
  search: vi.fn(async (query: string) => {
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    await new Promise((resolve) =>
      setTimeout(resolve, query === 'first' ? 30 : 5),
    );
    state.active -= 1;
    return {
      answer: `answer-${query}`,
      results: [],
      provider: 'exa' as const,
    };
  }),
}));

import web from '../index';

describe('query batching', () => {
  it('runs at most three searches concurrently while preserving input result order', async () => {
    state.active = 0;
    state.peak = 0;
    type Execute = (
      id: string,
      params: { queries: string[] },
      signal: AbortSignal,
      onUpdate: (update: unknown) => void,
      context: unknown,
    ) => Promise<{ content: Array<{ text: string }> }>;
    const tools = new Map<string, { execute: Execute }>();
    const entries: unknown[] = [];
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn((tool: { name: string; execute: Execute }) =>
        tools.set(tool.name, tool),
      ),
      appendEntry: vi.fn((_type: string, data: unknown) => entries.push(data)),
    };
    web(pi as never);
    const updates: unknown[] = [];
    const searchTool = tools.get('web_search');
    if (!searchTool) throw new Error('web_search was not registered');
    const result = await searchTool.execute(
      'call',
      { queries: ['first', 'second', 'third', 'fourth', 'fifth'] },
      new AbortController().signal,
      (update: unknown) => updates.push(update),
      {},
    );
    expect(state.peak).toBe(3);
    expect(result.content[0].text.indexOf('## first')).toBeLessThan(
      result.content[0].text.indexOf('## second'),
    );
    expect(
      (entries[0] as { queries: Array<{ query: string }> }).queries.map(
        (q) => q.query,
      ),
    ).toEqual(['first', 'second', 'third', 'fourth', 'fifth']);
    expect(updates).toHaveLength(10);
  });
});
