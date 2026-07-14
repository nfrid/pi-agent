import { afterEach, describe, expect, it, vi } from 'vitest';

const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalExaKey = process.env.EXA_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  process.env.OPENAI_API_KEY = originalOpenAiKey;
  process.env.EXA_API_KEY = originalExaKey;
});

describe('search providers', () => {
  it('uses Exa keyless MCP and maps results', async () => {
    delete process.env.EXA_API_KEY;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          `data: ${JSON.stringify({ result: { content: [{ type: 'text', text: 'Title: Example\nURL: https://example.com\nText: useful result' }] } })}\n`,
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { searchWithExa } = await import('../exa');
    const result = await searchWithExa('test query');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.exa.ai/mcp',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result?.results).toEqual([
      { title: 'Example', url: 'https://example.com', snippet: '' },
    ]);
  });

  it('uses OpenAI API auth and maps filters and citations', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          instructions: string;
          tools: Array<{ filters: unknown }>;
        };
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer sk-test',
        });
        expect(body.tools[0].filters).toEqual({
          allowed_domains: ['example.com'],
        });
        expect(body.instructions).toContain(
          'Do not use sources from: spam.com.',
        );
        return new Response(
          JSON.stringify({
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
          }),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const { searchWithOpenAI } = await import('../openai-search');
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
});
