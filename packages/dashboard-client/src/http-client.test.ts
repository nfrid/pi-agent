import { describe, expect, it, vi } from 'vitest';
import {
  DashboardHttpClient,
  DashboardProtocolMismatchError,
  SESSION_REQUEST_ORDER,
} from './http-client.js';

const validSnapshot = {
  serverId: 'daemon-1',
  revision: 1,
  cursor: 7,
  runtimes: [],
  workspaces: [],
  sessions: [],
  unread: [],
};

function trpcResponse(value: unknown): Response {
  return new Response(JSON.stringify({ result: { data: value } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function protocolInfoResponse(): Response {
  return trpcResponse({
    protocolVersion: 2,
    serverId: validSnapshot.serverId,
    capabilities: { shellSnapshot: true, sessionSnapshot: true },
  });
}

function snapshotResponse(): Response {
  return trpcResponse({
    snapshot: validSnapshot,
    cursor: validSnapshot.cursor,
  });
}

function trpcErrorResponse(
  code: string,
  httpStatus: number,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: 'dashboard error',
        code: -32000,
        data: { code, httpStatus, ...extra },
      },
    }),
    { status: httpStatus, headers: { 'content-type': 'application/json' } },
  );
}

function tokenStore() {
  return {
    get: () => 'test-token',
    set: () => undefined,
    clear: () => undefined,
  };
}

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

  it('requests an older session page with its opaque cursor in a POST body', async () => {
    const fetch = vi.fn(async () =>
      trpcResponse({
        metadata: { id: 'session-1', file: '', cwd: '/tmp', updatedAt: 1 },
        entries: [],
        history: { version: 1, start: 0, end: 0, hasOlder: false },
        entriesComplete: true,
        serverId: 'server-1',
        cursor: 1,
        active: {
          pendingInteractions: [],
          messages: [],
          tools: [],
          delegates: [],
          truncated: false,
        },
        completeThroughCursor: true,
      }),
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
    expect(calls[0]?.[0]).toBe('/trpc/sessionSnapshot');
    expect(calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'session-1',
        before: 'opaque token',
      }),
    });
  });

  it('orders latest session responses while isolating historical pages', async () => {
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const response = () =>
      trpcResponse({
        metadata: { id: 'session-1', file: '', cwd: '/tmp', updatedAt: 1 },
        entries: [],
        entriesComplete: true,
        serverId: 'server-1',
        cursor: 1,
        active: {
          pendingInteractions: [],
          messages: [],
          tools: [],
          delegates: [],
          truncated: false,
        },
        completeThroughCursor: true,
      });
    const fetch = vi.fn(async (_input: RequestInfo | URL) => {
      calls += 1;
      if (calls === 1) await firstRelease;
      return response();
    });
    const client = new DashboardHttpClient({ fetch, tokenStore: tokenStore() });
    const first = client.session('session-1');
    await Promise.resolve();
    const second = client.session('session-1');
    const historical = client.sessionBefore('session-1', 'older');
    releaseFirst();
    const [a, b, older] = await Promise.all([first, second, historical]);
    expect(
      (a as typeof a & Record<string, unknown>)[SESSION_REQUEST_ORDER],
    ).toBe(1);
    expect(
      (b as typeof b & Record<string, unknown>)[SESSION_REQUEST_ORDER],
    ).toBe(2);
    expect(
      (older as typeof older & Record<string, unknown>)[SESSION_REQUEST_ORDER],
    ).toBeUndefined();
  });

  it('fetches and validates the active delegate transcript baseline', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            version: 1,
            serverId: 'server-1',
            cursor: 4,
            sessionId: 'session-1',
            runtimeId: 'runtime-1',
            runtimeEpoch: 'epoch-1',
            runtimeSeq: 3,
            runs: [],
          }),
          { status: 200 },
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
    await expect(
      client.activeDelegateTranscripts('session-1'),
    ).resolves.toMatchObject({
      sessionId: 'session-1',
      runtimeEpoch: 'epoch-1',
      runs: [],
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/session-1/delegate-transcripts/active',
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it('fetches and validates persisted delegate history', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ version: 2, sessionId: 'session-1', groups: [] }),
          { status: 200 },
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
    await expect(client.delegateHistory('session-1')).resolves.toMatchObject({
      version: 2,
      sessionId: 'session-1',
      groups: [],
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/session-1/delegate-history',
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it('fetches one selected delegate detail with lineage and leaf pins', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            version: 1,
            sessionId: 'session-1',
            lineageId: 'lineage-1',
            runId: 'run-1',
            leafId: 'leaf-1',
            run: {
              runId: 'run-1',
              lineageId: 'lineage-1',
              name: 'Worker',
              kind: 'background',
              state: 'success',
              createdAt: 1,
              allowWrites: false,
              details: { response: 'selected', truncated: false },
            },
          }),
          { status: 200 },
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
    await expect(
      client.delegateHistoryRun('session-1', 'run-1', {
        lineageId: 'lineage-1',
        leafId: 'leaf-1',
      }),
    ).resolves.toMatchObject({
      runId: 'run-1',
      run: { details: { response: 'selected' } },
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/session-1/delegate-history/runs/run-1?lineageId=lineage-1&leafId=leaf-1',
      expect.objectContaining({ headers: expect.anything() }),
    );
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
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      await ready;
      return String(input).endsWith('/protocolInfo')
        ? protocolInfoResponse()
        : snapshotResponse();
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ cursor: 7 }),
      expect.objectContaining({ cursor: 7 }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    await client.snapshot();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('probes one candidate before the authenticated tRPC bootstrap and rejects malformed output', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/protocolInfo')
        ? protocolInfoResponse()
        : snapshotResponse(),
    );
    const client = new DashboardHttpClient({
      fetch,
      tokenStore: tokenStore(),
    });
    await expect(client.snapshot()).resolves.toEqual(validSnapshot);
    const calls = fetch.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit]
    >;
    expect(calls.map(([input]) => input)).toEqual([
      '/trpc/protocolInfo',
      '/trpc/shellSnapshot',
    ]);
    expect(calls.map(([, init]) => init.method)).toEqual(['POST', 'POST']);
    expect(calls[0]?.[1].body).toBe('null');
    expect(calls[1]?.[1].body).toBe(JSON.stringify({ protocolVersion: 2 }));

    const invalid = new DashboardHttpClient({
      fetch: vi.fn(async () => trpcResponse({ snapshot: validSnapshot })),
      tokenStore: tokenStore(),
    });
    await expect(invalid.snapshot()).rejects.toMatchObject({
      kind: 'malformed-output',
      code: 'malformed-output',
    });
  });

  it('classifies authentication, domain, and network tRPC failures', async () => {
    const authentication = new DashboardHttpClient({
      fetch: vi.fn(async () => trpcErrorResponse('UNAUTHORIZED', 401)),
      tokenStore: tokenStore(),
    });
    await expect(authentication.snapshot()).rejects.toMatchObject({
      kind: 'authentication',
      status: 401,
    });
    const plainAuthentication = new DashboardHttpClient({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'Authentication required.' }), {
            status: 401,
          }),
      ),
      tokenStore: tokenStore(),
    });
    await expect(plainAuthentication.snapshot()).rejects.toMatchObject({
      kind: 'authentication',
      status: 401,
    });

    const domain = new DashboardHttpClient({
      fetch: vi.fn(async () =>
        trpcErrorResponse('BAD_REQUEST', 400, {
          domainCode: 'active-session',
        }),
      ),
      tokenStore: tokenStore(),
    });
    await expect(domain.snapshot()).rejects.toMatchObject({
      kind: 'domain',
      code: 'active-session',
      status: 400,
    });

    const network = new DashboardHttpClient({
      fetch: vi.fn(async () => {
        throw new Error('offline');
      }),
      tokenStore: tokenStore(),
    });
    await expect(network.snapshot()).rejects.toMatchObject({
      kind: 'network',
      code: 'network-error',
    });
  });

  it('reads the token per tRPC request without putting it in the URL or input', async () => {
    let token = 'first-token';
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(_input)).not.toContain(token);
        expect(String(init?.body ?? '')).not.toContain(token);
        return String(_input).endsWith('/protocolInfo')
          ? protocolInfoResponse()
          : snapshotResponse();
      },
    );
    const client = new DashboardHttpClient({
      fetch,
      tokenStore: {
        get: () => token,
        set: () => undefined,
        clear: () => undefined,
      },
    });
    await client.snapshot();
    token = 'second-token';
    await client.snapshot();
    for (const index of [0, 1])
      expect(
        new Headers((fetch.mock.calls[index]?.[1] as RequestInit).headers).get(
          'x-dashboard-token',
        ),
      ).toBe('first-token');
    expect(
      new Headers((fetch.mock.calls[2]?.[1] as RequestInit).headers).get(
        'x-dashboard-token',
      ),
    ).toBe('second-token');
  });
});

describe('DashboardHttpClient candidate endpoint selection', () => {
  it('uses a LAN endpoint when its authenticated snapshot is valid', async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === '/lan/trpc/protocolInfo') return protocolInfoResponse();
        return new Response(JSON.stringify({ usage: {} }), { status: 200 });
      },
    );
    const client = new DashboardHttpClient({
      baseUrl: '/base',
      candidateBaseUrls: ['/lan'],
      fetch,
      tokenStore: tokenStore(),
    });

    await client.usage();

    expect(fetch.mock.calls.map(([input]) => input)).toEqual([
      '/lan/trpc/protocolInfo',
      '/lan/api/usage',
    ]);
    expect(
      new Headers((fetch.mock.calls[0]?.[1] as RequestInit).headers).get(
        'x-dashboard-token',
      ),
    ).toBe('test-token');
  });

  it.each([
    ['failed', 500],
    ['unauthorized', 401],
  ])('falls back after a LAN %s probe', async (_label, status) => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/lan/trpc/protocolInfo')
        return new Response('{}', { status });
      if (String(input) === '/base/trpc/protocolInfo')
        return protocolInfoResponse();
      return snapshotResponse();
    });
    const client = new DashboardHttpClient({
      baseUrl: '/base',
      candidateBaseUrls: ['/lan'],
      fetch,
      tokenStore: tokenStore(),
    });

    await expect(client.snapshot()).resolves.toMatchObject({
      serverId: 'daemon-1',
    });
    expect(fetch.mock.calls.map(([input]) => input)).toEqual([
      '/lan/trpc/protocolInfo',
      '/base/trpc/protocolInfo',
      '/base/trpc/shellSnapshot',
    ]);
  });

  it('falls back after a LAN probe returns an invalid snapshot', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === '/lan/trpc/protocolInfo'
        ? trpcResponse({ invalid: true })
        : String(input) === '/base/trpc/protocolInfo'
          ? protocolInfoResponse()
          : snapshotResponse(),
    );
    const client = new DashboardHttpClient({
      baseUrl: '/base',
      candidateBaseUrls: ['/lan'],
      fetch,
      tokenStore: tokenStore(),
    });

    await client.snapshot();
    expect(fetch.mock.calls.map(([input]) => input)).toEqual([
      '/lan/trpc/protocolInfo',
      '/base/trpc/protocolInfo',
      '/base/trpc/shellSnapshot',
    ]);
  });

  it('shares one in-flight selection across concurrent requests', async () => {
    let release!: () => void;
    const probeReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/lan/trpc/protocolInfo') {
        await probeReady;
        return protocolInfoResponse();
      }
      return new Response(JSON.stringify({ usage: {} }), { status: 200 });
    });
    const client = new DashboardHttpClient({
      baseUrl: '/base',
      candidateBaseUrls: ['/lan'],
      fetch,
      tokenStore: tokenStore(),
    });

    const first = client.usage();
    const second = client.usage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(fetch.mock.calls.map(([input]) => input)).toEqual([
      '/lan/trpc/protocolInfo',
      '/lan/api/usage',
      '/lan/api/usage',
    ]);
  });

  it('reuses the selection snapshot for the first public snapshot', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/protocolInfo')
        ? protocolInfoResponse()
        : snapshotResponse(),
    );
    const client = new DashboardHttpClient({
      baseUrl: '/base',
      candidateBaseUrls: ['/lan'],
      fetch,
      tokenStore: tokenStore(),
    });

    await expect(client.snapshot()).resolves.toMatchObject({ cursor: 7 });
    expect(fetch).toHaveBeenCalledTimes(2);
    await client.snapshot();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('classifies an incompatible protocolInfo response with generation metadata', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/protocolInfo')
        ? trpcResponse({
            protocolVersion: 1,
            serverId: 'old-generation',
            capabilities: { shellSnapshot: true, sessionSnapshot: true },
          })
        : snapshotResponse(),
    );
    const client = new DashboardHttpClient({
      baseUrl: '/base',
      candidateBaseUrls: ['/lan'],
      fetch,
      tokenStore: tokenStore(),
    });
    await expect(client.snapshot()).rejects.toBeInstanceOf(
      DashboardProtocolMismatchError,
    );
    await expect(client.snapshot()).rejects.toMatchObject({
      expected: 2,
      actual: 1,
      serverId: 'old-generation',
      code: 'protocol-mismatch',
      kind: 'protocol-mismatch',
    });
    expect(fetch.mock.calls.map(([input]) => input)).toEqual([
      '/lan/trpc/protocolInfo',
    ]);
  });

  it('does not bootstrap or pin a fallback after a one-candidate protocol mismatch', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/protocolInfo'))
        return trpcResponse({
          protocolVersion: 1,
          serverId: 'incompatible-generation',
          capabilities: { shellSnapshot: true, sessionSnapshot: true },
        });
      throw new Error('bootstrap must not be called');
    });
    const client = new DashboardHttpClient({
      baseUrl: '/only',
      fetch,
      tokenStore: tokenStore(),
    });
    const error = await client.snapshot().catch((cause) => cause);
    expect(error).toMatchObject({
      expected: 2,
      actual: 1,
      serverId: 'incompatible-generation',
      code: 'protocol-mismatch',
    });
    expect(error).toBeInstanceOf(DashboardProtocolMismatchError);
    expect(fetch.mock.calls.map(([input]) => input)).toEqual([
      '/only/trpc/protocolInfo',
    ]);
  });

  it('sends a mutation once, only after endpoint selection', async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) =>
        String(input).endsWith('/trpc/protocolInfo')
          ? protocolInfoResponse()
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const client = new DashboardHttpClient({
      baseUrl: '/base',
      candidateBaseUrls: ['/lan'],
      fetch,
      tokenStore: tokenStore(),
    });

    await client.sendCommand('runtime-1', { id: 'command-1', type: 'abort' });
    expect(fetch.mock.calls.map(([input]) => input)).toEqual([
      '/lan/trpc/protocolInfo',
      '/lan/api/runtimes/runtime-1/command',
    ]);
    expect(fetch.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ method: 'POST' }),
    );
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

  it('uses the pinned endpoint for the event stream', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/trpc/protocolInfo')
        ? protocolInfoResponse()
        : new Response(null, { status: 200 }),
    );
    const client = new DashboardHttpClient({
      baseUrl: '/base',
      candidateBaseUrls: ['/lan'],
      fetch,
      tokenStore: tokenStore(),
    });

    await client.events(4, new AbortController().signal);
    expect(fetch.mock.calls.map(([input]) => input)).toEqual([
      '/lan/trpc/protocolInfo',
      '/lan/api/events?cursor=4',
    ]);
  });
});
