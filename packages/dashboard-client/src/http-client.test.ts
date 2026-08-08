import { describe, expect, it, vi } from 'vitest';
import { DashboardHttpClient } from './http-client.js';

describe('DashboardHttpClient command requests', () => {
  it('fetches and validates workspace composer commands', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            commands: [
              {
                name: 'review',
                description: 'Review code',
                argumentHint: '<path>',
                source: 'prompt',
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const client = new DashboardHttpClient({
      fetch,
      tokenStore: {
        get: () => 'test-token',
        set: () => undefined,
        clear: () => undefined,
      },
    });
    await expect(client.composerCommands('workspace/1')).resolves.toEqual({
      commands: [
        {
          name: 'review',
          description: 'Review code',
          argumentHint: '<path>',
          source: 'prompt',
        },
      ],
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/workspaces/workspace%2F1/composer-commands',
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it('rejects malformed workspace composer command responses', async () => {
    const client = new DashboardHttpClient({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ commands: [] }), { status: 200 }),
      ),
      tokenStore: {
        get: () => undefined,
        set: () => undefined,
        clear: () => undefined,
      },
    });
    await expect(client.composerCommands('workspace')).resolves.toEqual({
      commands: [],
    });

    const invalid = new DashboardHttpClient({
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              commands: [{ name: 'bad', source: 'extension' }],
            }),
            { status: 200 },
          ),
      ),
      tokenStore: {
        get: () => undefined,
        set: () => undefined,
        clear: () => undefined,
      },
    });
    await expect(invalid.composerCommands('workspace')).rejects.toThrow(
      'invalid composer command',
    );
  });

  it('requests an older session page with an encoded opaque cursor', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            metadata: { id: 'session-1', file: '', cwd: '/tmp', updatedAt: 1 },
            entries: [],
            history: { version: 1, start: 0, end: 1, hasOlder: false },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const client = new DashboardHttpClient({
      fetch,
      tokenStore: {
        get: () => undefined,
        set: () => undefined,
        clear: () => undefined,
      },
    });
    await client.sessionBefore('session-1', 'opaque token');
    const calls = fetch.mock.calls as unknown as Array<[unknown, RequestInit]>;
    expect(calls[0]?.[0]).toBe('/api/sessions/session-1?before=opaque%20token');
  });

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

  it('uses GET for checkout review', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const client = new DashboardHttpClient({
      fetch,
      tokenStore: {
        get: () => 'test-token',
        set: () => undefined,
        clear: () => undefined,
      },
    });
    await client.reviewCheckout('checkout-1');
    const call = fetch.mock.calls as unknown as Array<[unknown, RequestInit]>;
    expect(call[0]?.[0]).toBe('/api/checkouts/checkout-1/review');
    expect(call[0]?.[1]?.method).toBe('GET');
    expect(call[0]?.[1]?.body).toBeUndefined();
  });

  it('posts a project-scoped first-message runtime request', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ runtimeId: 'runtime-1' }), {
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
    await client.startRuntime({
      workspaceId: 'workspace-1',
      initialPrompt: 'inspect this',
    });
    const call = fetch.mock.calls as unknown as Array<[unknown, RequestInit]>;
    expect(call[0]?.[0]).toBe('/api/runtimes/start');
    expect(JSON.parse(String(call[0]?.[1]?.body))).toEqual({
      workspaceId: 'workspace-1',
      initialPrompt: 'inspect this',
    });
  });

  it('posts a resume request with the existing session identity', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ runtimeId: 'runtime-1' }), {
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
    await client.startRuntime({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
    });
    const call = fetch.mock.calls as unknown as Array<[unknown, RequestInit]>;
    expect(JSON.parse(String(call[0]?.[1]?.body))).toEqual({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
    });
  });
});

describe('DashboardHttpClient snapshot requests', () => {
  it('coalesces concurrent snapshot reads without caching the result', async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async () => {
      await ready;
      return new Response(
        JSON.stringify({
          serverId: 'daemon-1',
          revision: 1,
          cursor: 7,
          runtimes: [],
          workspaces: [],
          sessions: [],
          unread: [],
        }),
        { status: 200 },
      );
    });
    const client = new DashboardHttpClient({
      fetch,
      tokenStore: {
        get: () => 'test-token',
        set: () => undefined,
        clear: () => undefined,
      },
    });
    const first = client.snapshot();
    const second = client.snapshot();
    expect(fetch).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ cursor: 7 }),
      expect.objectContaining({ cursor: 7 }),
    ]);
    await client.snapshot();
    expect(fetch).toHaveBeenCalledTimes(2);
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
