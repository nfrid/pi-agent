import { expect, test } from '@playwright/test';

const snapshot = {
  serverId: 'history-navigation-test',
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
    {
      id: 'session-2',
      file: '/tmp/session-2.jsonl',
      cwd: '/tmp',
      updatedAt: 2,
    },
  ],
  unread: [],
};

const entries = {
  'session-1': [
    {
      type: 'message',
      id: 'latest-1',
      message: { role: 'assistant', content: 'latest session one' },
    },
  ],
  'session-2': [
    {
      type: 'message',
      id: 'latest-2',
      message: { role: 'user', content: 'second session' },
    },
  ],
};

test('aborts older history when navigating to another session', async ({
  page,
}) => {
  let releaseOlder!: () => void;
  let olderStarted!: () => void;
  const olderRequestStarted = new Promise<void>((resolve) => {
    olderStarted = resolve;
  });
  const olderRequestRelease = new Promise<void>((resolve) => {
    releaseOlder = resolve;
  });
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(snapshot),
    }),
  );
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/sessions/*', async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split('/').at(-1) ?? '';
    const before = url.searchParams.get('before');
    if (id === 'session-1' && before) {
      olderStarted();
      await olderRequestRelease;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          metadata: snapshot.sessions[0],
          entries: [
            { type: 'session', id: 'session-1', cwd: '/tmp' },
            {
              type: 'message',
              id: 'first-user',
              message: { role: 'user', content: 'old session one' },
            },
          ],
          entriesComplete: false,
          serverId: snapshot.serverId,
          cursor: 1,
          history: { version: 1, start: 0, end: 2, hasOlder: false },
        }),
      });
    }
    const session = id === 'session-2' ? 'session-2' : 'session-1';
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        metadata: snapshot.sessions[session === 'session-2' ? 1 : 0],
        entries: entries[session],
        entriesComplete: false,
        serverId: snapshot.serverId,
        cursor: 1,
        ...(session === 'session-1'
          ? {
              history: {
                version: 1,
                start: 2,
                end: 3,
                hasOlder: true,
                nextBefore: 'token-1',
              },
            }
          : {}),
      }),
    });
  });

  await page.goto('/sessions/session-1');
  await expect(
    page.getByRole('button', { name: 'Load earlier history' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Load earlier history' }).click();
  await olderRequestStarted;
  await page.goto('/sessions/session-2');
  await expect(
    page.getByRole('heading', { name: 'second session' }),
  ).toBeVisible();
  releaseOlder();
  await expect(page.getByText('old session one')).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: /Load earlier history|Retry earlier history/,
    }),
  ).toHaveCount(0);
});
