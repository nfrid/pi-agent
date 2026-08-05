import { describe, expect, it, vi } from 'vitest';
import { DashboardHttpClient } from './http-client.js';

describe('DashboardHttpClient command requests', () => {
  it('allocates one command ID without changing caller-owned IDs', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = new DashboardHttpClient({
      fetch,
      tokenStore: {
        get: () => 'test-token',
        set: () => undefined,
        clear: () => undefined,
      },
    });
    await client.sendCommand('runtime-1', { type: 'abort' });
    await client.sendCommand('runtime-1', { id: 'caller-id', type: 'abort' });
    const calls = fetch.mock.calls as unknown as Array<[unknown, RequestInit]>;
    const first = JSON.parse(String(calls[0]?.[1]?.body)) as { id?: string };
    const second = JSON.parse(String(calls[1]?.[1]?.body)) as { id?: string };
    expect(first.id).toBeTruthy();
    expect(second.id).toBe('caller-id');
    expect(first.id).not.toBe(second.id);
  });

  it('uses a stable non-retried ID for restart requests', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = new DashboardHttpClient({
      fetch,
      tokenStore: {
        get: () => 'test-token',
        set: () => undefined,
        clear: () => undefined,
      },
    });
    await client.restartRuntime('runtime-1', 'restart-id');
    const call = fetch.mock.calls as unknown as Array<[unknown, RequestInit]>;
    expect(JSON.parse(String(call[0]?.[1]?.body))).toMatchObject({
      id: 'restart-id',
    });
  });
});

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
