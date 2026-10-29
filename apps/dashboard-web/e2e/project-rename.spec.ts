import { expect, type Page, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

const projects = [
  { id: 'a', title: 'Project A', rootPath: '/tmp/project-a', status: 'active' },
  { id: 'b', title: 'Project B', rootPath: '/tmp/project-b', status: 'active' },
] as const;

async function prepareProjects(page: Page) {
  await page.route('**/api/**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/trpc/**', (route) => route.fulfill({ status: 404 }));
  await installDashboardBootstrap(page, {
    serverId: 'project-rename',
    revision: 1,
    cursor: 1,
    runtimes: [],
    projects: [...projects],
    checkouts: [],
    sessions: [],
    threads: [],
    runs: [],
    unread: [],
  });
  await page.goto('/projects/a');
  await expect(
    page.getByRole('heading', { name: 'Project A', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Project name' })
    .fill('Edited A title');
}

async function navigateToB(page: Page) {
  await page.evaluate(() => {
    window.history.pushState({}, '', '/projects/b');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(
    page.getByRole('heading', { name: 'Project B', exact: true }),
  ).toBeVisible();
}

test('project rename state belongs to the selected project', async ({
  page,
}) => {
  await prepareProjects(page);
  await navigateToB(page);

  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue(
    'Project B',
  );

  const renamed: unknown[] = [];
  await page.route('**/api/projects/b', async (route) => {
    renamed.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        ...projects[1],
        title: 'Renamed B',
        defaultIsolation: 'main',
        maxParallelRuns: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    });
  });
  await page.getByRole('textbox', { name: 'Project name' }).fill('Renamed B');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveCount(
    0,
  );
  expect(renamed).toEqual([expect.objectContaining({ title: 'Renamed B' })]);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`project rename state ignores a previous project's late ${outcome}`, async ({
    page,
  }) => {
    await prepareProjects(page);
    let releaseResponse = () => {};
    const responseReady = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let requestStarted = () => {};
    const requestReady = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    await page.route('**/api/projects/a', async (route) => {
      requestStarted();
      await responseReady;
      await route.fulfill(
        outcome === 'success'
          ? {
              json: {
                ...projects[0],
                title: 'Edited A title',
                defaultIsolation: 'main',
                maxParallelRuns: 1,
                createdAt: 1,
                updatedAt: 2,
              },
            }
          : { status: 409, json: { error: 'Project A rename failed' } },
      );
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await requestReady;
    await navigateToB(page);
    await expect(
      page.getByRole('textbox', { name: 'Project name' }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: 'Project name' }).fill('B draft');

    const response = page.waitForResponse('**/api/projects/a');
    releaseResponse();
    await (await response).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );

    await expect(
      page.getByRole('textbox', { name: 'Project name' }),
    ).toHaveValue('B draft');
    await expect(
      page.getByRole('button', { name: 'Save', exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}
