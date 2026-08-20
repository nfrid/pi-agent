import {
  type BrowserSnapshot,
  DASHBOARD_PROTOCOL_VERSION,
} from '@pi-dashboard/protocol';
import type { Page, Request } from '@playwright/test';

export type DashboardFixtureOptions = {
  protocolInfo?: Record<string, unknown>;
  shellSnapshot?: Record<string, unknown>;
  sessionSnapshot?: Record<string, unknown>;
  sessionSnapshots?: Record<string, Record<string, unknown>>;
  sessionSubscribeDelayMs?: number;
};

export function trpcData(data: unknown): string {
  return JSON.stringify({ result: { data } });
}

export function trpcSseData(data: unknown, id: string): string {
  const sequence =
    data &&
    typeof data === 'object' &&
    'sequence' in data &&
    typeof (data as { sequence?: unknown }).sequence === 'number'
      ? (data as { sequence: number }).sequence
      : 0;
  return `event: connected\ndata: ${JSON.stringify({ reconnectAfterInactivityMs: 60_000 })}\n\nid: ${id}\ndata: ${JSON.stringify(data)}\n\nid: ${id}-caught-up\ndata: ${JSON.stringify({ type: 'caught-up', sequence })}\n\n`;
}

function assertSubscriptionRequest(request: Request): void {
  const url = new URL(request.url());
  if (request.headers()['x-dashboard-token'] !== 'test-token')
    throw new Error('Subscription token must be sent in x-dashboard-token.');
  if (url.toString().includes('test-token'))
    throw new Error('Subscription token must not enter the URL.');
  if (JSON.stringify(dashboardTrpcInput(request)).includes('test-token'))
    throw new Error('Subscription token must not enter tRPC input.');
}

/** Decode the stock tRPC input from either POST bodies or legacy GET URLs. */
export function dashboardTrpcInput(request: Request): Record<string, unknown> {
  try {
    const raw =
      request.method() === 'POST'
        ? request.postData()
        : new URL(request.url()).searchParams.get('input');
    const input = raw ? JSON.parse(raw) : {};
    return input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Install the same authenticated protocol-v3 shell read used by production. */
export async function installDashboardBootstrap(
  page: Page,
  snapshot: BrowserSnapshot,
  options: DashboardFixtureOptions = {},
): Promise<void> {
  await page.addInitScript(() =>
    localStorage.setItem('pi-dashboard-token', 'test-token'),
  );
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/api/snapshot'))
      throw new Error('Unexpected legacy /api/snapshot request.');
    if (pathname.endsWith('/api/events'))
      throw new Error('Unexpected legacy /api/events request.');
    if (pathname === '/ws')
      throw new Error('Unexpected browser WebSocket request.');
    if (pathname.endsWith('/trpc/shellSnapshot'))
      throw new Error('Unexpected finite shell snapshot request.');
  });
  await page.route('**/trpc/protocolInfo*', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: trpcData(
        options.protocolInfo ?? {
          protocolVersion: DASHBOARD_PROTOCOL_VERSION,
          serverId: snapshot.serverId,
          capabilities: { shellSnapshot: true, sessionSnapshot: true },
        },
      ),
    }),
  );
  await page.route('**/trpc/usage*', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: trpcData({}),
    }),
  );
  await page.route('**/trpc/shellSubscribe*', async (route) => {
    assertSubscriptionRequest(route.request());
    const id = 'shell-fixture-1';
    await route.fulfill({
      contentType: 'text/event-stream',
      body: trpcSseData(
        {
          type: 'snapshot',
          sequence: snapshot.cursor,
          snapshot: {
            snapshot: options.shellSnapshot ?? snapshot,
            cursor: snapshot.cursor,
          },
        },
        id,
      ),
    });
  });
  await page.route('**/trpc/sessionSubscribe*', async (route) => {
    assertSubscriptionRequest(route.request());
    const input = dashboardTrpcInput(route.request());
    const sessionId =
      typeof input.sessionId === 'string' ? input.sessionId : 'session-1';
    const metadata = snapshot.sessions.find(
      (session) => session.id === sessionId,
    ) ?? {
      id: sessionId,
      file: '',
      cwd: '',
      updatedAt: 1,
    };
    if (options.sessionSubscribeDelayMs)
      await new Promise((resolve) =>
        setTimeout(resolve, options.sessionSubscribeDelayMs),
      );
    await route.fulfill({
      contentType: 'text/event-stream',
      body: trpcSseData(
        {
          type: 'snapshot',
          sequence: snapshot.cursor,
          snapshot: {
            metadata,
            entries: [],
            entriesComplete: true,
            serverId: snapshot.serverId,
            cursor: snapshot.cursor,
            active: {
              pendingInteractions: [],
              messages: [],
              tools: [],
              delegates: [],
              truncated: false,
            },
            completeThroughCursor: true,
            ...(options.sessionSnapshots?.[sessionId] ??
              options.sessionSnapshot ??
              {}),
          },
        },
        `session-fixture-${sessionId}`,
      ),
    });
  });
}
