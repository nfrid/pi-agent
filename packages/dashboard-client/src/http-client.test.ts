import { describe, expect, it, vi } from 'vitest';
import { DashboardHttpClient } from './http-client.js';

describe('DashboardHttpClient event requests', () => {
  it('sends the known daemon generation with the replay cursor', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const client = new DashboardHttpClient({
      fetch,
      tokenStore: {
        get: () => 'test-token',
        set: () => undefined,
        clear: () => undefined,
      },
    });
    await client.events(4, new AbortController().signal, 'daemon-a');
    expect(fetch).toHaveBeenCalledWith(
      '/api/events?cursor=4&serverId=daemon-a',
      expect.objectContaining({
        headers: {
          accept: 'text/event-stream',
          'x-dashboard-token': 'test-token',
        },
      }),
    );
  });
});
