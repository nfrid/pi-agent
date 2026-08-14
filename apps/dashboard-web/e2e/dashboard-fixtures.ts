import {
  type BrowserSnapshot,
  DASHBOARD_PROTOCOL_VERSION,
} from '@pi-dashboard/protocol';
import type { Page } from '@playwright/test';

export type DashboardFixtureOptions = {
  protocolInfo?: Record<string, unknown>;
  shellSnapshot?: Record<string, unknown>;
  sessionSnapshot?: Record<string, unknown>;
};

function trpcData(data: unknown): string {
  return JSON.stringify({ result: { data } });
}

/** Install the same authenticated protocol-v2 shell read used by production. */
export async function installDashboardBootstrap(
  page: Page,
  snapshot: BrowserSnapshot,
  options: DashboardFixtureOptions = {},
): Promise<void> {
  await page.addInitScript(() =>
    localStorage.setItem('pi-dashboard-token', 'test-token'),
  );
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/api/snapshot'))
      throw new Error('Unexpected legacy /api/snapshot request.');
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
  await page.route('**/trpc/shellSnapshot*', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: trpcData(
        options.shellSnapshot ?? { snapshot, cursor: snapshot.cursor },
      ),
    }),
  );
  await page.route('**/trpc/sessionSnapshot*', async (route) => {
    const requestUrl = new URL(route.request().url());
    let sessionId = 'session-1';
    try {
      const input = JSON.parse(requestUrl.searchParams.get('input') ?? '{}');
      if (typeof input.sessionId === 'string') sessionId = input.sessionId;
    } catch {
      // The production client/parser reports malformed tRPC input; fixtures
      // keep a deterministic fallback response for unrelated startup reads.
    }
    const metadata = snapshot.sessions.find(
      (session) => session.id === sessionId,
    ) ?? {
      id: sessionId,
      file: '',
      cwd: '',
      updatedAt: 1,
    };
    await route.fulfill({
      contentType: 'application/json',
      body: trpcData(
        options.sessionSnapshot ?? {
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
        },
      ),
    });
  });
}
