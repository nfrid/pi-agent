import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import type { Page } from '@playwright/test';

export type DashboardFixtureOptions = {
  protocolInfo?: Record<string, unknown>;
  bootstrap?: Record<string, unknown>;
};

function trpcData(data: unknown): string {
  return JSON.stringify({ result: { data } });
}

/** Install the same authenticated protocol/bootstrap reads used by production. */
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
          protocolVersion: 1,
          serverId: snapshot.serverId,
          capabilities: { bootstrap: true },
        },
      ),
    }),
  );
  await page.route('**/trpc/bootstrap*', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: trpcData(
        options.bootstrap ?? { snapshot, cursor: snapshot.cursor },
      ),
    }),
  );
}
