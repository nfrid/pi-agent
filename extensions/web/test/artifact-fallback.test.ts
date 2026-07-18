import { describe, expect, it, vi } from 'vitest';

vi.mock('../../artifacts', () => ({
  MAX_ARTIFACT_BYTES: 16 * 1024 * 1024,
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

import { artifactProducer, MAX_ARTIFACT_BYTES } from '../../artifacts';
import web from '../index';
import { search } from '../search';
import { createWebResultStore, WEB_FALLBACK_TYPE } from '../storage';

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

    const restored = createWebResultStore();
    restored.restore({
      sessionManager: { getBranch: () => entries },
    } as never);
    expect(restored.get(fallback.data.id)).toEqual(fallback.data);
  });

  it('does not publish continuation state after cancellation during artifact persistence', async () => {
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(artifactProducer.put).mockImplementationOnce(
      async (_pi, _ctx, _input, _root, assertCurrent) => {
        started();
        await gate;
        assertCurrent?.();
        return { handle: 'art_aaaaaaaaaaaaaaaaaaaaaa' } as never;
      },
    );
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
    const controller = new AbortController();
    const pending = tools
      .get('web_search')
      ?.execute(
        'cancel-persistence',
        { query: 'cancel me' },
        controller.signal,
      );
    await began;
    const cancellation = new Error('cancelled persistence');
    controller.abort(cancellation);
    release();

    await expect(pending).rejects.toBe(cancellation);
    expect(entries).toEqual([]);
  });

  it('invalidates in-flight persistence across session shutdown', async () => {
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(artifactProducer.put).mockImplementationOnce(
      async (_pi, _ctx, _input, _root, assertCurrent) => {
        started();
        await gate;
        assertCurrent?.();
        return { handle: 'art_aaaaaaaaaaaaaaaaaaaaaa' } as never;
      },
    );
    const tools = new Map<string, Tool>();
    const handlers = new Map<string, () => void>();
    const entries: Array<{ type: string; customType?: string; data: unknown }> =
      [];
    web({
      on: vi.fn((event: string, handler: () => void) =>
        handlers.set(event, handler),
      ),
      registerTool: vi.fn((tool: Tool & { name: string }) =>
        tools.set(tool.name, tool),
      ),
      appendEntry: vi.fn((type: string, data: unknown) =>
        entries.push({ type: 'custom', customType: type, data }),
      ),
    } as never);
    const pending = tools
      .get('web_search')
      ?.execute(
        'shutdown-persistence',
        { query: 'cross branch' },
        new AbortController().signal,
      );
    await began;
    handlers.get('session_shutdown')?.();
    release();

    await expect(pending).rejects.toThrow(
      'Web operation crossed a session lifecycle boundary',
    );
    expect(entries).toEqual([]);
  });

  it('does not advertise continuation when both artifact and fallback append fail', async () => {
    const tools = new Map<string, Tool>();
    web({
      on: vi.fn(),
      registerTool: vi.fn((tool: Tool & { name: string }) =>
        tools.set(tool.name, tool),
      ),
      appendEntry: vi.fn(() => {
        throw new Error('session append failed');
      }),
    } as never);

    const result = await tools
      .get('web_search')
      ?.execute(
        'append-failure',
        { query: 'fallback append failure' },
        new AbortController().signal,
        undefined,
        undefined,
      );
    expect(result?.content[0].text).not.toContain('get_search_content');
    expect(result?.details?.continuationAvailable).toBe(false);
    await expect(
      tools
        .get('get_search_content')
        ?.execute(
          'missing-after-append-failure',
          { responseId: result?.details?.responseId },
          new AbortController().signal,
        ),
    ).rejects.toThrow('No stored result');
  });

  it('throws terminal tool failures instead of returning an ignored isError field', async () => {
    const tools = new Map<string, Tool>();
    web({
      on: vi.fn(),
      registerTool: vi.fn((tool: Tool & { name: string }) =>
        tools.set(tool.name, tool),
      ),
      appendEntry: vi.fn(),
    } as never);

    await expect(
      tools
        .get('web_search')
        ?.execute(
          'missing-query',
          {},
          new AbortController().signal,
          undefined,
          undefined,
        ),
    ).rejects.toThrow('Provide query or queries.');
    await expect(
      tools
        .get('get_search_content')
        ?.execute(
          'missing-result',
          { responseId: 'missing' },
          new AbortController().signal,
          undefined,
          undefined,
        ),
    ).rejects.toThrow('No stored result for missing.');
  });

  it('does not retain or advertise continuation for an oversized aggregate', async () => {
    vi.mocked(search).mockResolvedValueOnce({
      answer: 'ü'.repeat(MAX_ARTIFACT_BYTES / 2),
      results: [],
      provider: 'exa' as const,
    });
    vi.mocked(artifactProducer.put).mockClear();
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
      'oversized',
      { query: 'oversized test' },
      new AbortController().signal,
      undefined,
      undefined,
    );

    expect(artifactProducer.put).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
    expect(result.content[0].text).not.toContain('get_search_content');
    expect(result.content[0].text).toContain(
      'aggregate result exceeded the persistence limit',
    );
    expect(result.details?.continuationAvailable).toBe(false);
    await expect(
      tools
        .get('get_search_content')
        ?.execute(
          'missing-oversized',
          { responseId: result.details?.responseId },
          new AbortController().signal,
        ),
    ).rejects.toThrow('No stored result');
  });
});
