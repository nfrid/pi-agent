import { expect, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

const project = {
  id: 'project-draft-delete',
  title: 'Draft deletion project',
  rootPath: '/tmp/draft-delete',
};

function draft(id: string, title: string) {
  return {
    id,
    projectId: project.id,
    createdAt: 1,
    updatedAt: 1,
    isolation: 'main',
    location: { kind: 'current' },
    title,
  };
}

async function prepareDrafts(
  page: import('@playwright/test').Page,
  drafts: ReturnType<typeof draft>[],
) {
  await page.addInitScript((storedDrafts) => {
    localStorage.setItem(
      'pi-dashboard-drafts:v1',
      JSON.stringify(storedDrafts),
    );
  }, drafts);
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 404, body: '' }),
  );
  await page.route('**/trpc/**', (route) =>
    route.fulfill({ status: 404, body: '' }),
  );
  await installDashboardBootstrap(page, {
    serverId: 'draft-delete',
    revision: 1,
    cursor: 1,
    runtimes: [],
    projects: [project],
    checkouts: [],
    sessions: [],
    threads: [],
    runs: [],
    unread: [],
  });
}

test('deleting the open draft returns to the projects page', async ({
  page,
}) => {
  await prepareDrafts(page, [draft('draft-active', 'Active draft')]);
  await page.goto('/drafts/draft-active');
  await expect(
    page.getByRole('heading', { name: 'New thread', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open agent list' }).click();

  await page.getByRole('button', { name: 'Delete draft Active draft' }).click();

  await expect(page).toHaveURL('/projects');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem('pi-dashboard-drafts:v1')),
  ).toBe('[]');
});

test('deleting an inactive draft keeps the open draft', async ({ page }) => {
  await prepareDrafts(page, [
    draft('draft-active', 'Active draft'),
    draft('draft-inactive', 'Inactive draft'),
  ]);
  await page.goto('/drafts/draft-active');
  await expect(page.getByRole('heading', { name: 'New thread' })).toBeVisible();
  await page.getByRole('button', { name: 'Open agent list' }).click();

  await page
    .getByRole('button', { name: 'Delete draft Inactive draft' })
    .click();

  await expect(page).toHaveURL('/drafts/draft-active');
  await expect(
    page.getByRole('heading', { name: 'New thread', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem('pi-dashboard-drafts:v1') ?? '[]').map(
        (item: { id: string }) => item.id,
      ),
    ),
  ).toEqual(['draft-active']);
});

test('an unknown draft route keeps its deleted-draft message', async ({
  page,
}) => {
  await prepareDrafts(page, []);
  await page.goto('/drafts/draft-missing');
  await expect(page.getByText('Draft deleted')).toBeVisible();
  await expect(
    page.getByText('Select a thread or start a new one.'),
  ).toBeVisible();
  await expect(page).toHaveURL('/drafts/draft-missing');
});
