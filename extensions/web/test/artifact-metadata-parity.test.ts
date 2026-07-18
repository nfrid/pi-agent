import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const metadata = {
  handle: `art_${'m'.repeat(22)}`,
  sha256: '',
  size: 0,
  producer: 'web' as const,
  contentClass: 'json' as const,
  mediaType: 'application/json',
  creationSource: 'web.search',
  encoding: 'utf-8' as const,
  lineCount: 1,
  itemCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../../artifacts', () => ({
  MAX_ARTIFACT_BYTES: 16 * 1024 * 1024,
  artifactProducer: {
    put: vi.fn(
      async (_pi: unknown, _ctx: unknown, input: { bytes: string }) => {
        const bytes = Buffer.from(input.bytes);
        return {
          ...metadata,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
          itemCount: Object.keys(JSON.parse(input.bytes)).length,
        };
      },
    ),
  },
}));
vi.mock('../search', () => ({
  search: vi.fn(async () => ({
    answer: 'fresh artifact answer',
    results: [],
    provider: 'exa' as const,
  })),
}));

import web from '../index';

type Tool = {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details?: Record<string, unknown>;
  }>;
};

describe('fresh web artifact metadata', () => {
  it('is immediately available to continuation results', async () => {
    const tools = new Map<string, Tool>();
    web({
      on: vi.fn(),
      registerTool: vi.fn((tool: Tool & { name: string }) =>
        tools.set(tool.name, tool),
      ),
      appendEntry: vi.fn(),
    } as never);
    const controller = new AbortController();
    const initial = await tools
      .get('web_search')
      ?.execute('search', { query: 'metadata' }, controller.signal);
    const responseId = initial?.details?.responseId as string;
    const continued = await tools
      .get('get_search_content')
      ?.execute('continue', { responseId, view: 'summary' }, controller.signal);

    expect(continued?.details?.artifact).toMatchObject({
      handle: metadata.handle,
      producer: 'web',
      contentClass: 'json',
      creationSource: 'web.search',
    });
  });
});
