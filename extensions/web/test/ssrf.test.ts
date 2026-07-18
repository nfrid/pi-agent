import { describe, expect, it, vi } from 'vitest';
import { validateRemoteUrl as validatePolicyUrl } from '../ssrf-policy';
import { fetchRemoteUrl, validateRemoteUrl } from '../ssrf-protection';

describe('SSRF address policy', () => {
  it('rejects a DNS answer set containing any private address', async () => {
    await expect(
      validatePolicyUrl('https://example.test', {
        lookup: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ],
      }),
    ).rejects.toThrow('Blocked internal address');
  });

  it('fails closed for empty and non-IP DNS answers', async () => {
    await expect(
      validatePolicyUrl('https://empty.test', { lookup: async () => [] }),
    ).rejects.toThrow('no addresses returned');
    await expect(
      validatePolicyUrl('https://invalid.test', {
        lookup: async () => [{ address: 'not-an-ip', family: 4 }],
      }),
    ).rejects.toThrow('Resolved non-IP address');
  });

  it('strictly validates configured CIDR exceptions', async () => {
    await expect(
      validatePolicyUrl('http://198.18.0.1', {
        allowRanges: ['198.18.0.0/15'],
      }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      validatePolicyUrl('http://198.18.0.1', {
        allowRanges: ['198.18.0.0/0'],
      }),
    ).rejects.toThrow('Invalid CIDR notation');
  });
});

describe('SSRF protection', () => {
  it('blocks private DNS results', async () => {
    await expect(
      validateRemoteUrl('https://example.test', {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    ).rejects.toThrow('Blocked internal address');
  });

  it('pins the validated destination and validates redirects', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://second.test/next' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok'));
    await expect(
      fetchRemoteUrl(
        'https://public.test',
        {},
        {
          lookup: async (hostname) => [
            {
              address:
                hostname === 'public.test' ? '93.184.216.34' : '93.184.216.35',
              family: 4,
            },
          ],
          fetch: fetchMock,
        },
      ),
    ).resolves.toBeInstanceOf(Response);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[2]).toEqual({
      address: '93.184.216.34',
      family: 4,
    });
    expect(fetchMock.mock.calls[1]?.[2]).toEqual({
      address: '93.184.216.35',
      family: 4,
    });
  });

  it('blocks a private redirect before connection establishment', async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'http://private.test/secret' },
        }),
      ),
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

  it('strips credentials across origins and preserves HEAD on 303', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 303,
          headers: { location: 'https://other.test/next' },
        }),
      )
      .mockResolvedValueOnce(new Response(null));
    await fetchRemoteUrl(
      'https://public.test/start',
      {
        method: 'HEAD',
        headers: {
          authorization: 'Bearer secret',
          cookie: 'session=secret',
          'x-safe': 'kept',
        },
      },
      {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetch: fetchMock,
      },
    );

    const redirectedInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const headers = new Headers(redirectedInit.headers);
    expect(redirectedInit.method).toBe('HEAD');
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect(headers.get('x-safe')).toBe('kept');
  });

  it.each([
    'http://192.0.0.9/',
    'http://192.0.2.1/',
    'http://198.51.100.1/',
    'http://203.0.113.1/',
  ])('blocks reserved IPv4 destination %s', async (url) => {
    await expect(validateRemoteUrl(url)).rejects.toThrow(
      'Blocked internal address',
    );
  });

  it.each([
    'http://[::1]/',
    'http://[ff02::1]/',
    'http://[fec0::1]/',
    'http://[feff:ffff::1]/',
    'http://[::192.168.1.1]/',
  ])('blocks special IPv6 destination %s', async (url) => {
    await expect(validateRemoteUrl(url)).rejects.toThrow(
      'Blocked internal address',
    );
  });
});
