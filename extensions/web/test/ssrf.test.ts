import { describe, expect, it, vi } from 'vitest';
import { fetchRemoteUrl, validateRemoteUrl } from '../ssrf-protection';

describe('SSRF protection', () => {
  it('blocks private DNS results', async () => {
    await expect(
      validateRemoteUrl('https://example.test', {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    ).rejects.toThrow('Blocked internal address');
  });

  it('validates redirect destinations', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://private.test/secret' },
        }),
    );
    await expect(
      fetchRemoteUrl(
        'https://public.test',
        {},
        {
          lookup: async (hostname) => [
            {
              address:
                hostname === 'public.test' ? '93.184.216.34' : '10.0.0.1',
              family: 4,
            },
          ],
          fetch: fetchMock,
        },
      ),
    ).rejects.toThrow('Blocked internal address');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
