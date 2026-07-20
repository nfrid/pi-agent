import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
let agentDir = '';

beforeEach(() => {
  agentDir = mkdtempSync(path.join(tmpdir(), 'openai-provider-'));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
  rmSync(agentDir, { recursive: true, force: true });
});

function responseOutput() {
  return {
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'Web answer',
            annotations: [
              {
                type: 'url_citation',
                start_index: 0,
                end_index: 3,
                url: 'https://example.com/docs?utm_source=openai',
                title: 'Docs',
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('OpenAI search transport', () => {
  it('uses API auth and maps request filters and citations', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer sk-test' });
      expect(body.tools[0].filters).toEqual({
        allowed_domains: ['example.com'],
      });
      expect(body.instructions).toContain('Do not use sources from: spam.com.');
      expect(body).toMatchObject({
        stream: true,
        store: false,
        tool_choice: 'required',
        parallel_tool_calls: true,
        include: ['web_search_call.action.sources'],
      });
      return Response.json(responseOutput());
    });
    vi.stubGlobal('fetch', fetchMock);
    const { searchWithOpenAI } = await import('../openai-search.js');
    const result = await searchWithOpenAI('docs', {
      domainFilter: ['example.com', '-spam.com'],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.openai.com/v1/responses',
    );
    expect(result).toEqual({
      answer: 'Web answer',
      results: [
        {
          title: 'Docs',
          url: 'https://example.com/docs',
          snippet: 'Web answer',
        },
      ],
    });
  });

  it('prefers model-registry Codex auth and preserves resolved headers', async () => {
    process.env.OPENAI_API_KEY = 'env-fallback';
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer registry-key',
        'x-registry': 'preserved',
        originator: 'pi',
      });
      return Response.json(responseOutput());
    });
    vi.stubGlobal('fetch', fetchMock);
    const ctx = {
      modelRegistry: {
        getAll: () => [{ provider: 'openai-codex', id: 'gpt-5.4' }],
        getApiKeyAndHeaders: vi.fn(async () => ({
          ok: true,
          apiKey: 'registry-key',
          headers: { 'x-registry': 'preserved' },
        })),
      },
    };
    const { searchWithOpenAI } = await import('../openai-search.js');
    await searchWithOpenAI('docs', {}, ctx as never);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://chatgpt.com/backend-api/codex/responses',
    );
  });

  it('selects the Codex endpoint and account header for Codex JWTs', async () => {
    const payload = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
      }),
    ).toString('base64url');
    process.env.OPENAI_API_KEY = `header.${payload}.signature`;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        'chatgpt-account-id': 'account-1',
        originator: 'pi',
      });
      return Response.json(responseOutput());
    });
    vi.stubGlobal('fetch', fetchMock);
    const { searchWithOpenAI } = await import('../openai-search.js');
    await searchWithOpenAI('docs');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://chatgpt.com/backend-api/codex/responses',
    );
  });

  it('composes caller cancellation into the transport signal', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const fetchMock = vi.fn(async () => Response.json(responseOutput()));
    vi.stubGlobal('fetch', fetchMock);
    const { searchWithOpenAI } = await import('../openai-search.js');
    await expect(
      searchWithOpenAI('docs', { signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves bounded HTTP errors', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 403 })),
    );
    const { searchWithOpenAI } = await import('../openai-search.js');
    await expect(searchWithOpenAI('docs')).rejects.toThrow(
      'OpenAI API error 403: denied',
    );
  });
});
