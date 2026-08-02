import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractContent } from '../extract';

const { fetchRemoteUrl, validateRemoteUrl, fetchWithRetry } = vi.hoisted(
  () => ({
    fetchRemoteUrl: vi.fn(),
    validateRemoteUrl: vi.fn(async (url: string) => new URL(url)),
    fetchWithRetry: vi.fn(),
  }),
);

vi.mock('../ssrf-protection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ssrf-protection')>()),
  fetchRemoteUrl,
  validateRemoteUrl,
}));

vi.mock('../utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils')>()),
  fetchWithRetry,
}));

describe('dynamic page extraction', () => {
  beforeEach(() => {
    fetchRemoteUrl.mockReset();
    validateRemoteUrl.mockClear();
    fetchWithRetry.mockReset();
  });

  it('uses Jina when embedded RSC data has no useful readable article', async () => {
    const url = 'https://example.test/app';
    const html = `<!doctype html>
      <html>
        <head><title>Dynamic app</title></head>
        <body><main>Loading</main></body>
        <script>self.__next_f.push([1,"23:[\\"$\\",\\"main\\",null,{\\"children\\":\\"Navigation only\\"}]\\n"])</script>
        <script src="/one.js"></script>
        <script src="/two.js"></script>
        <script src="/three.js"></script>
      </html>`;
    fetchRemoteUrl.mockResolvedValue(
      new Response(html, { headers: { 'content-type': 'text/html' } }),
    );
    fetchWithRetry.mockResolvedValue(
      new Response(
        'Title: Dynamic app\n\nMarkdown Content:\n# Actual application\n\nUseful rendered content from the dynamic page, including the primary controls, explanatory copy, account choices, and application-specific details.',
      ),
    );

    await expect(
      extractContent(url, undefined, {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      }),
    ).resolves.toMatchObject({
      url,
      title: 'Actual application',
      content:
        '# Actual application\n\nUseful rendered content from the dynamic page, including the primary controls, explanatory copy, account choices, and application-specific details.',
      error: null,
    });
    expect(fetchWithRetry).toHaveBeenCalledWith(
      `https://r.jina.ai/${url}`,
      expect.objectContaining({
        headers: { Accept: 'text/markdown', 'X-No-Cache': 'true' },
      }),
    );
  });
});
