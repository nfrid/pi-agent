import { expect, test } from '@playwright/test';

const project = {
  id: 'p1',
  title: 'Demo project',
  rootPath: '/workspace/demo',
  status: 'active',
  maxParallelRuns: 2,
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
  sessions: [],
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
    page.getByRole('heading', { name: 'Demo project' }),
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

test('management desktop has persistent rail and queues a complete prompt', async ({
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
  await page.getByRole('button', { name: '+ New thread' }).click();
  await page.getByRole('textbox', { name: 'Title' }).fill('New queued task');
  await page
    .getByRole('textbox', { name: 'Complete prompt' })
    .fill('Implement the complete task with all constraints.');
  await page.getByRole('button', { name: 'Queue thread' }).click();
  await expect(page).toHaveURL(/\/threads\/t-new$/u);
});
