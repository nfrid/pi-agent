import { describe, expect, it, vi } from 'vitest';

vi.mock('../../artifacts', () => ({
  artifactProducer: {
    put: vi.fn(async () => {
      throw new Error('artifact policy failure at /private/path');
    }),
  },
}));
vi.mock('../search', () => ({
  search: vi.fn(async () => ({
    answer: `answer-${'x'.repeat(35_000)}`,
    results: [],
    provider: 'exa' as const,
  })),
}));

import web from '../index';
import {
  clearResults,
  getResult,
  restoreFromSession,
  WEB_FALLBACK_TYPE,
} from '../storage';

type Tool = {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate?: (value: unknown) => void,
    ctx?: unknown,
  ) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details?: Record<string, unknown>;
    isError?: boolean;
  }>;
};

describe('web artifact fallback', () => {
  it('keeps successful output, exact continuation guidance, and restores fallback without TTL', async () => {
    const tools = new Map<string, Tool>();
    const entries: Array<{ type: string; customType?: string; data: unknown }> =
      [];
    web({
      on: vi.fn(),
      registerTool: vi.fn((tool: Tool & { name: string }) =>
        tools.set(tool.name, tool),
      ),
      appendEntry: vi.fn((type: string, data: unknown) =>
        entries.push({ type: 'custom', customType: type, data }),
      ),
    } as never);

    const searchTool = tools.get('web_search');
    if (!searchTool) throw new Error('web_search was not registered');
    const result = await searchTool.execute(
      'search',
      { query: 'fallback test' },
      new AbortController().signal,
      undefined,
      undefined,
    );
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('get_search_content');
    expect(result.details?.artifactWarning).toBe(
      'Exact artifact unavailable; retained an in-session fallback.',
    );
    expect(result.details?.artifact).toBeUndefined();
    expect(entries).toHaveLength(1);
    expect(entries[0].customType).toBe(WEB_FALLBACK_TYPE);
    const fallback = entries[0].data as {
      version: number;
      data: { id: string; timestamp: number };
    };
    expect(fallback.version).toBe(1);
    fallback.data.timestamp = 1;

    restoreFromSession({
      sessionManager: { getBranch: () => entries },
    } as never);
    expect(getResult(fallback.data.id)).toEqual(fallback.data);
    clearResults();
  });
});
