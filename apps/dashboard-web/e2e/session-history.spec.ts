import { expect, test } from '@playwright/test';

const snapshot = {
  serverId: 'history-test',
  revision: 1,
  cursor: 1,
  runtimes: [],
  workspaces: [],
  sessions: [
    {
      id: 'session-1',
      file: '/tmp/session-1.jsonl',
      cwd: '/tmp',
      updatedAt: 1,
    },
  ],
  unread: [],
};

const metadata = snapshot.sessions[0];

test('loads earlier session history on demand', async ({ page }) => {
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(snapshot),
    }),
  );
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  let beforeRequest: string | undefined;
  await page.route('**/api/sessions/session-1*', async (route) => {
    const url = new URL(route.request().url());
    beforeRequest = url.searchParams.get('before') ?? undefined;
    const older = beforeRequest !== undefined;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        metadata,
        entries: older
          ? [
              { type: 'session', id: 'session-1', cwd: '/tmp' },
              {
                type: 'message',
                id: 'first-user',
                message: { role: 'user', content: 'first request' },
              },
            ]
          : [
              {
                type: 'message',
                id: 'latest',
                message: { role: 'assistant', content: 'latest response' },
              },
            ],
        entriesComplete: false,
        serverId: 'history-test',
        cursor: 1,
        history: older
          ? { version: 1, start: 0, end: 2, hasOlder: false }
          : {
              version: 1,
              start: 2,
              end: 3,
              hasOlder: true,
              nextBefore: 'token-1',
            },
      }),
    });
  });

  await page.goto('/sessions/session-1');
  await expect(
    page.getByRole('button', { name: 'Load earlier history' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Load earlier history' }).click();
  await expect(page.getByText('first request')).toBeVisible();
  await expect.poll(() => beforeRequest).toBe('token-1');
  await expect(
    page.getByRole('button', {
      name: /Load earlier history|Retry earlier history/,
    }),
  ).toHaveCount(0);
});
