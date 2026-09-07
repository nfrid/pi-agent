import { expect, test } from '@playwright/test';
import { installDashboardBootstrap, trpcData } from './dashboard-fixtures';

for (const suffix of ['', ' @desktop']) {
  test(`file viewer browser history preserves the underlying inspector${suffix}`, async ({
    page,
  }) => {
    const run = {
      runId: 'run',
      lineageId: 'lineage',
      name: 'File review',
      kind: 'background',
      state: 'success',
      createdAt: 1,
      finishedAt: 2,
      allowWrites: false,
    };
    await installDashboardBootstrap(
      page,
      {
        serverId: 'nested-files',
        revision: 1,
        cursor: 1,
        runtimes: [],
        workspaces: [],
        unread: [],
        sessions: [
          {
            id: 'nested-files',
            file: '/tmp/session.jsonl',
            cwd: '/parent',
            updatedAt: 1,
          },
        ],
      },
      {
        sessionSnapshot: {
          entries: [],
          entriesComplete: true,
          active: { messages: [], tools: [], delegates: [], truncated: false },
          completeThroughCursor: true,
        },
      },
    );
    await page.route('**/api/sessions/nested-files/delegate-history', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: 2,
          sessionId: 'nested-files',
          groups: [
            {
              id: 'lineage',
              ...run,
              runCount: 1,
              runs: [run],
            },
          ],
        }),
      }),
    );
    await page.route(
      '**/api/sessions/nested-files/delegate-history/runs/run?*',
      (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            version: 1,
            sessionId: 'nested-files',
            lineageId: 'lineage',
            runId: 'run',
            run: {
              ...run,
              details: {
                task: '[Review notes](/child/notes.md)',
                setup: { cwd: '/child' },
                truncated: false,
              },
            },
          }),
        }),
    );
    await page.route('**/trpc/readFile*', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: trpcData({
          path: '/child/notes.md',
          content:
            '# Review notes\n\n[Next section](#next)\n\n## Next\n\nSecond section.',
        }),
      }),
    );
    await page.goto('/sessions/nested-files');
    if (!suffix) await page.locator('.run-status-disclosure-trigger').click();
    const launcher = page.locator(
      'article.extension-surface[aria-label="Delegates"] button.surface-launcher',
    );
    await expect(launcher).toBeVisible();
    await launcher.click();
    await page.getByRole('button', { name: /File review/ }).click();
    const inspector = page.getByRole('dialog', {
      name: 'Delegate · File review',
      exact: true,
    });
    const notesLink = inspector.getByRole('link', {
      name: 'Review notes',
      exact: true,
    });
    await expect(notesLink).toBeVisible();
    await notesLink.click();
    const viewer = page.locator('.file-viewer-surface');
    await expect(
      viewer.getByRole('heading', { name: 'Review notes', exact: true }),
    ).toBeVisible();
    await viewer
      .getByRole('link', { name: 'Next section', exact: true })
      .click();
    await expect(
      viewer.getByRole('button', { name: 'Back', exact: true }),
    ).toBeEnabled();
    await page.goBack();
    await expect(
      viewer.getByRole('button', { name: 'Back', exact: true }),
    ).toBeDisabled();
    await page.goBack();
    await expect(viewer).not.toBeVisible();
    await expect(inspector).toBeVisible();
    await expect(notesLink).toBeFocused();
    await page.goForward();
    await expect(viewer).toBeVisible();
    await page.goForward();
    await expect(
      viewer.getByRole('button', { name: 'Back', exact: true }),
    ).toBeEnabled();
    await viewer
      .getByRole('button', { name: 'Close file viewer', exact: true })
      .click();
    await expect(viewer).not.toBeVisible();
    await expect(inspector).toBeVisible();
    // Closing the viewer must not leave dead history entries above this inspector.
    await page.goBack();
    await expect(
      page.getByRole('dialog', { name: 'Delegates', exact: true }),
    ).toBeVisible();
    await expect(inspector).not.toBeVisible();
    await expect(page).toHaveURL(/\/sessions\/nested-files$/);
  });
}
