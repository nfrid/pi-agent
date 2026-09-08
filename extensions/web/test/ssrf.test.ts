import http from 'node:http';
import {
  brotliCompressSync,
  createGzip,
  deflateSync,
  gzipSync,
} from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { validateRemoteUrl as validatePolicyUrl } from '../ssrf-policy';
import { fetchRemoteUrl, validateRemoteUrl } from '../ssrf-protection';
import { readResponseTextLimited } from '../utils';

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
  it('fetches a hostname through the pinned production transport', async () => {
    const server = http.createServer((_request, response) => {
      response.end('loopback hostname');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const response = await fetchRemoteUrl(
        `http://loopback.test:${address.port}/`,
        {},
        {
          allowRanges: ['127.0.0.1/32'],
          lookup: async () => [{ address: '127.0.0.1', family: 4 }],
        },
      );
      await expect(response.text()).resolves.toBe('loopback hostname');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    ['gzip', gzipSync('compressed gzip')],
    ['deflate', deflateSync('compressed deflate')],
    ['br', brotliCompressSync('compressed br')],
  ])('decodes %s responses', async (encoding, body) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, {
        'content-encoding': encoding,
        'content-length': body.byteLength,
      });
      response.end(body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const response = await fetchRemoteUrl(
        `http://127.0.0.1:${address.port}/`,
        {},
        { allowRanges: ['127.0.0.1/32'] },
      );
      await expect(response.text()).resolves.toBe(`compressed ${encoding}`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    ['corrupt', Buffer.from('not gzip')],
    ['truncated', gzipSync('truncated').subarray(0, 8)],
  ])('surfaces %s compressed body errors', async (_name, body) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip' });
      response.end(body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const response = await fetchRemoteUrl(
        `http://127.0.0.1:${address.port}/`,
        {},
        { allowRanges: ['127.0.0.1/32'] },
      );
      await expect(response.text()).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    'cancel',
    'abort',
  ])('closes an ongoing compressed connection on %s', async (action) => {
    const controller = new AbortController();
    let closedResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      closedResolve = resolve;
    });
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip' });
      response.on('close', () => closedResolve?.());
      const gzip = createGzip();
      gzip.pipe(response);
      const interval = setInterval(
        () => gzip.write('ongoing compressed data\\n'),
        5,
      );
      response.on('close', () => {
        clearInterval(interval);
        gzip.destroy();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const response = await fetchRemoteUrl(
        `http://127.0.0.1:${address.port}/`,
        { signal: controller.signal },
        { allowRanges: ['127.0.0.1/32'] },
      );
      if (action === 'cancel') await response.body?.cancel('test cancellation');
      else {
        controller.abort();
        await expect(response.text()).rejects.toThrow();
      }
      await expect(
        Promise.race([
          closed,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('server stayed open')), 1_000),
          ),
        ]),
      ).resolves.toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('rejects oversized decompressed responses', async () => {
    const body = gzipSync(Buffer.alloc(5 * 1024 * 1024 + 1, 65));
    const server = http.createServer((_request, response) => {
      response.writeHead(200, {
        'content-encoding': 'gzip',
        'content-length': body.byteLength,
      });
      response.end(body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const response = await fetchRemoteUrl(
        `http://127.0.0.1:${address.port}/`,
        {},
        { allowRanges: ['127.0.0.1/32'] },
      );
      await expect(
        readResponseTextLimited(response, 5 * 1024 * 1024),
      ).rejects.toThrow('Response too large');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
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

  it('cancels a real redirect body when the redirect limit is exceeded', async () => {
    let closedResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      closedResolve = resolve;
    });
    const server = http.createServer((_request, response) => {
      response.writeHead(302, { location: '/next' });
      const interval = setInterval(() => response.write('discard me\n'), 5);
      response.on('close', () => {
        clearInterval(interval);
        closedResolve?.();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      await expect(
        fetchRemoteUrl(
          `http://127.0.0.1:${address.port}/`,
          {},
          { allowRanges: ['127.0.0.1/32'], maxRedirects: 0 },
        ),
      ).rejects.toThrow('Too many redirects');
      await expect(
        Promise.race([
          closed,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('server stayed open')), 1_000),
          ),
        ]),
      ).resolves.toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    'identity',
    'unsupported',
  ])('handles %s content encoding at the transport boundary', async (encoding) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-encoding': encoding });
      response.end('plain text');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const pending = fetchRemoteUrl(
        `http://127.0.0.1:${address.port}/`,
        {},
        {
          allowRanges: ['127.0.0.1/32'],
        },
      );
      if (encoding === 'identity')
        await expect((await pending).text()).resolves.toBe('plain text');
      else
        await expect(pending).rejects.toThrow('Unsupported content encoding');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
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
