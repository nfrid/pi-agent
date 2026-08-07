import { expect, test } from '@playwright/test';

const project = {
  id: 'p1',
  title: 'Demo project',
  rootPath: '/workspace/demo',
  status: 'active',
  maxParallelRuns: 2,
  defaultIsolation: 'main',
  activeRunCount: 1,
  updatedAt: 10,
};
const snapshot = {
  serverId: 'management-test',
  revision: 1,
  cursor: 1,
  runtimes: [],
  workspaces: [
    {
      id: 'w1',
      name: 'Demo',
      path: '/workspace/demo',
      canonicalPath: '/workspace/demo',
      source: 'directory',
      active: true,
    },
  ],
  sessions: [
    {
      id: 'legacy-session',
      file: '/workspace/demo/.pi/sessions/legacy.jsonl',
      cwd: '/workspace/demo/.worktree/task',
      title: 'Legacy work',
      updatedAt: 8,
    },
  ],
  unread: [],
  projects: [project],
  checkouts: [
    {
      id: 'c1',
      projectId: 'p1',
      kind: 'worktree',
      path: '/workspace/demo/.worktree/task',
      branch: 'pi/task',
      status: 'dirty',
      changedFileCount: 2,
      updatedAt: 10,
    },
  ],
  threads: [
    {
      id: 't-running',
      projectId: 'p1',
      title: 'Running task',
      checkoutId: 'c1',
      status: 'active',
      activeRunId: 'r-running',
      updatedAt: 5,
    },
    {
      id: 't-queued',
      projectId: 'p1',
      title: 'Queued task',
      checkoutId: 'c1',
      status: 'queued',
      updatedAt: 4,
    },
    {
      id: 't-failed',
      projectId: 'p1',
      title: 'Needs review',
      checkoutId: 'c1',
      status: 'failed',
      updatedAt: 3,
    },
  ],
  runs: [
    {
      id: 'r-running',
      threadId: 't-running',
      checkoutId: 'c1',
      attempt: 1,
      mode: 'write',
      runtimeProvider: 'pi-server',
      status: 'running',
      createdAt: 1,
      startedAt: 2,
    },
    {
      id: 'r-queued',
      threadId: 't-queued',
      checkoutId: 'c1',
      attempt: 1,
      mode: 'read',
      runtimeProvider: 'pi-server',
      status: 'queued',
      createdAt: 1,
    },
    {
      id: 'r-failed',
      threadId: 't-failed',
      checkoutId: 'c1',
      attempt: 1,
      mode: 'write',
      runtimeProvider: 'pi-server',
      status: 'failed',
      createdAt: 1,
      finishedAt: 3,
      error: 'Provider failed',
    },
  ],
};

async function mockManagementApi(page: import('@playwright/test').Page) {
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(snapshot),
    }),
  );
}

test('management mobile drawer, shelves, thread history, and no overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await mockManagementApi(page);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'All projects' }),
  ).toBeVisible();
  await expect(
    page.locator('.management-shelf h2').filter({ hasText: 'Running' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open project rail' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open project rail' }).click();
  await expect(
    page.getByRole('complementary', { name: 'Projects' }),
  ).toBeVisible();
  await page
    .getByRole('complementary', { name: 'Projects' })
    .getByRole('button', { name: 'Close project rail' })
    .click();
  await page.getByRole('button', { name: 'Running task' }).click();
  await expect(page).toHaveURL(/\/threads\/t-running$/u);
  await expect(
    page.getByRole('heading', { name: 'Run history' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.body.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test('legacy session adoption uses typed endpoint and navigates to thread', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await mockManagementApi(page);
  let posted: Record<string, unknown> | undefined;
  await page.route(
    '**/api/projects/p1/sessions/legacy-session/adopt',
    async (route) => {
      expect(route.request().method()).toBe('POST');
      posted = JSON.parse(route.request().postData() ?? '{}') as Record<
        string,
        unknown
      >;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          thread: { id: 't-adopted' },
          run: { id: 'r-adopted' },
          receipt: {},
        }),
      });
    },
  );
  await page.goto('/projects/p1');
  await expect(
    page.getByRole('heading', { name: 'Unassigned Pi sessions' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Adopt as thread' }).click();
  await expect.poll(() => posted).toEqual({ commandId: expect.any(String) });
  await expect(page).toHaveURL(/\/threads\/t-adopted$/u);
});

test('thread actions guard active checkout and interrupt exactly once', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await mockManagementApi(page);
  let cancelCount = 0;
  let cancelBody: Record<string, unknown> | undefined;
  await page.route('**/api/runs/r-running/cancel', async (route) => {
    cancelCount += 1;
    cancelBody = JSON.parse(route.request().postData() ?? '{}') as Record<
      string,
      unknown
    >;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ id: 'r-running', status: 'cancelled' }),
    });
  });
  await page.goto('/threads/t-running');
  await expect(
    page.getByRole('button', { name: 'Merge', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Retire', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Interrupt run' }).click();
  await expect.poll(() => cancelCount).toBe(1);
  await expect
    .poll(() => cancelBody)
    .toMatchObject({ commandId: expect.any(String) });
});

test('terminal worktree exposes confirmed merge action', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await mockManagementApi(page);
  const terminal = {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === 't-running'
        ? { ...thread, status: 'settled' as const }
        : thread,
    ),
    runs: snapshot.runs.map((run) =>
      run.id === 'r-running'
        ? { ...run, status: 'settled' as const, finishedAt: 4 }
        : run,
    ),
  };
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(terminal),
    }),
  );
  let mergeCount = 0;
  await page.route('**/api/checkouts/c1/merge', async (route) => {
    mergeCount += 1;
    expect(JSON.parse(route.request().postData() ?? '{}')).toMatchObject({
      commandId: expect.any(String),
    });
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        checkout: { id: 'c1', status: 'retired' },
        outcome: { merged: true },
      }),
    });
  });
  await page.goto('/threads/t-running');
  await expect(
    page.getByRole('button', { name: 'Merge', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Retire', exact: true }),
  ).toBeEnabled();
  page.on('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect.poll(() => mergeCount).toBe(1);
});

test('main checkout never exposes integration actions', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await mockManagementApi(page);
  const main = {
    ...snapshot,
    checkouts: snapshot.checkouts.map((checkout) => ({
      ...checkout,
      kind: 'main' as const,
    })),
    runs: snapshot.runs.map((run) =>
      run.id === 'r-running'
        ? { ...run, status: 'settled' as const, finishedAt: 4 }
        : run,
    ),
  };
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(main),
    }),
  );
  await page.goto('/threads/t-running');
  await expect(
    page.getByRole('button', { name: 'Review checkout', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Merge', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Retire', exact: true }),
  ).toBeDisabled();
});

test('managed thread reuses transcript and blocks pending ask-user without agent rail', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const managed = {
    ...snapshot,
    sessions: [
      {
        id: 'pi-1',
        file: '/workspace/demo/pi-1.jsonl',
        cwd: '/workspace/demo/.worktree/task',
        updatedAt: 9,
      },
    ],
    runtimes: [
      {
        runtimeId: 'runtime-1',
        ownership: 'external',
        pid: 1,
        cwd: '/workspace/demo/.worktree/task',
        liveState: 'waiting',
        online: true,
        session: { id: 'pi-1', title: 'Managed transcript', entries: [] },
        pendingInteractions: [
          {
            id: 'ask-1',
            type: 'ask_user',
            question: 'Choose a direction',
            choices: [],
            allowCustom: true,
            createdAt: 1,
          },
        ],
      },
    ],
    runs: snapshot.runs.map((run) =>
      run.id === 'r-running'
        ? { ...run, piSessionId: 'pi-1', status: 'waiting' }
        : run,
    ),
  };
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(managed),
    }),
  );
  await page.route('**/api/sessions/pi-1', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        metadata: {
          id: 'pi-1',
          file: '/workspace/demo/pi-1.jsonl',
          cwd: '/workspace/demo/.worktree/task',
          updatedAt: 9,
        },
        entries: [],
        entriesComplete: true,
      }),
    }),
  );
  await page.goto('/threads/t-running');
  await expect(page.getByRole('heading', { name: 'Transcript' })).toBeVisible();
  await expect(page.getByText('Choose a direction')).toBeVisible();
  await expect(
    page.getByRole('complementary', { name: 'Agents and threads' }),
  ).toHaveCount(0);
});

test('global new thread uses the managed thread project', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const secondProject = {
    ...project,
    id: 'p2',
    title: 'Second project',
    rootPath: '/workspace/second',
    defaultIsolation: 'worktree',
  };
  const multiProject = {
    ...snapshot,
    projects: [project, secondProject],
    threads: snapshot.threads.map((thread) =>
      thread.id === 't-running' ? { ...thread, projectId: 'p2' } : thread,
    ),
  };
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(multiProject),
    }),
  );
  await page.goto('/threads/t-running');
  await page.getByRole('button', { name: 'New thread' }).click();
  await expect(page).toHaveURL(/\/projects\/p2\/new$/u);
});

test('@desktop management desktop has persistent rail and queues a complete prompt', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockManagementApi(page);
  await page.route('**/api/projects/p1/threads', (route) =>
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        thread: { id: 't-new' },
        run: { id: 'r-new', status: 'queued' },
        receipt: {
          idempotencyKey: 'x',
          commandType: 'thread.create',
          result: {},
          createdAt: 1,
        },
      }),
    }),
  );
  await page.goto('/');
  await expect(
    page.getByRole('complementary', { name: 'Projects' }),
  ).toBeVisible();
  await page.goto('/projects/p1');
  await page.getByRole('button', { name: '+ New thread' }).click();
  await page.getByRole('textbox', { name: 'Title' }).fill('New queued task');
  await page
    .getByRole('textbox', { name: 'Complete prompt' })
    .fill('Implement the complete task with all constraints.');
  await expect(page.getByRole('radio', { name: 'Main' })).toBeChecked();
  await page.getByRole('button', { name: 'Queue thread' }).click();
  await expect(page).toHaveURL(/\/threads\/t-new$/u);
});
