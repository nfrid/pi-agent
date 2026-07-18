import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalExaKey = process.env.EXA_API_KEY;
let agentDir = '';

beforeEach(() => {
  agentDir = mkdtempSync(path.join(tmpdir(), 'exa-provider-'));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalExaKey === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = originalExaKey;
  rmSync(agentDir, { recursive: true, force: true });
});

describe('Exa provider', () => {
  it('uses keyless MCP with the exact tool request and maps SSE results', async () => {
    delete process.env.EXA_API_KEY;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'web_search_exa',
          arguments: {
            query: 'test query site:example.com',
            numResults: 3,
            livecrawl: 'fallback',
            type: 'auto',
            contextMaxCharacters: 50_000,
          },
        },
      });
      return new Response(
        `data: ${JSON.stringify({ result: { content: [{ type: 'text', text: 'Title: Example\nURL: https://example.com\nText: useful result' }] } })}\n`,
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { searchWithExa } = await import('../exa');
    const result = await searchWithExa('test query', {
      domainFilter: ['example.com'],
      numResults: 3,
      includeContent: true,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://mcp.exa.ai/mcp');
    expect(result).toMatchObject({
      results: [{ title: 'Example', url: 'https://example.com', snippet: '' }],
      inlineContent: [
        {
          url: 'https://example.com',
          title: 'Example',
          content: 'useful result',
          error: null,
        },
      ],
    });
  });

  it('accepts MCP JSON and preserves RPC and empty-content errors', async () => {
    const { callExaMcp } = await import('../exa');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ result: { content: [{ type: 'text', text: 'ok' }] } }),
      ),
    );
    await expect(callExaMcp('tool', {})).resolves.toBe('ok');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: { code: -1, message: 'bad' } })),
    );
    await expect(callExaMcp('tool', {})).rejects.toThrow(
      'Exa MCP error -1: bad',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: { content: [] } })),
    );
    await expect(callExaMcp('tool', {})).rejects.toThrow(
      'Exa MCP returned empty content',
    );
  });

  it('uses keyed answer transport for default searches', async () => {
    process.env.EXA_API_KEY = 'exa-test';
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ 'x-api-key': 'exa-test' });
      expect(JSON.parse(String(init?.body))).toEqual({
        query: 'question',
        text: true,
      });
      return Response.json({
        answer: 'answer',
        citations: [{ title: 'Docs', url: 'https://example.com' }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { searchWithExa } = await import('../exa');
    await expect(searchWithExa('question')).resolves.toEqual({
      answer: 'answer',
      results: [{ title: 'Docs', url: 'https://example.com', snippet: '' }],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.exa.ai/answer');
  });

  it('preserves keyed HTTP errors and caller cancellation signals', async () => {
    process.env.EXA_API_KEY = 'exa-test';
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const fetchMock = vi.fn(
      async () => new Response('denied', { status: 429 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { searchWithExa } = await import('../exa');
    await expect(
      searchWithExa('question', { signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(searchWithExa('question')).rejects.toThrow(
      'Exa API error 429: denied',
    );
  });

  it('uses keyed search transport for filters and maps inline content', async () => {
    process.env.EXA_API_KEY = 'exa-test';
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        query: 'query',
        numResults: 2,
        includeDomains: ['example.com'],
        excludeDomains: ['spam.com'],
        contents: { text: true, highlights: true },
      });
      return Response.json({
        results: [
          {
            title: 'Docs',
            url: 'https://example.com',
            text: 'full text',
            highlights: ['highlight'],
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { searchWithExa } = await import('../exa');
    const result = await searchWithExa('query', {
      numResults: 2,
      domainFilter: ['example.com', '-spam.com'],
      includeContent: true,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.exa.ai/search');
    expect(result?.answer).toContain('highlight');
    expect(result?.inlineContent?.[0]?.content).toBe('full text');
  });
});
