import { expect, test } from '@playwright/test';
import {
  dashboardTrpcInput,
  installDashboardBootstrap,
  trpcData,
} from './dashboard-fixtures';

test('file viewer reports read and stale-line errors and recovers', async ({
  page,
}) => {
  await installDashboardBootstrap(
    page,
    {
      serverId: 'viewer-errors',
      revision: 1,
      cursor: 1,
      runtimes: [],
      workspaces: [],
      unread: [],
      sessions: [
        {
          id: 'viewer-errors',
          file: '/tmp/session.jsonl',
          cwd: '/project',
          updatedAt: 1,
        },
      ],
    },
    {
      sessionSnapshot: {
        entries: [
          {
            type: 'message',
            id: 'links',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: '[Missing](missing.ts) [Stale](short.ts:123) [Markdown line](notes.md:3)',
                },
              ],
            },
          },
        ],
        entriesComplete: true,
        active: { messages: [], tools: [], delegates: [], truncated: false },
        completeThroughCursor: true,
      },
    },
  );
  let missing = true;
  await page.route('**/trpc/readFile*', async (route) => {
    const input = dashboardTrpcInput(route.request());
    if (input.path === 'missing.ts' && missing) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            message: 'File not found.',
            code: -32600,
            data: { code: 'BAD_REQUEST', httpStatus: 400, path: 'readFile' },
          },
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        path: `/project/${input.path}`,
        content:
          input.path === 'notes.md'
            ? '# Notes\n\nTarget source line\n'
            : 'export const short = true;\n',
      }),
    });
  });
  await page.goto('/sessions/viewer-errors');
  const transcript = page.getByRole('region', {
    name: 'Transcript',
    exact: true,
  });
  await transcript.getByRole('link', { name: 'Missing', exact: true }).click();
  const viewer = page.getByRole('dialog').last();
  await expect(viewer.getByRole('alert')).toContainText('File not found');
  missing = false;
  await viewer
    .getByRole('button', { name: 'Refresh file', exact: true })
    .click();
  await expect(
    viewer.getByText('export const short = true;', { exact: false }),
  ).toBeVisible();
  await viewer
    .getByRole('button', { name: 'Close file viewer', exact: true })
    .click();
  await transcript.getByRole('link', { name: 'Stale', exact: true }).click();
  await expect(viewer).toContainText(/123/);
  await expect(viewer).toContainText(
    /outside|out of range|only .*lines|exceeds/i,
  );
  await expect(
    viewer.getByText('export const short = true;', { exact: false }),
  ).toBeVisible();
  await viewer
    .getByRole('button', { name: 'Close file viewer', exact: true })
    .click();
  await transcript
    .getByRole('link', { name: 'Markdown line', exact: true })
    .click();
  await expect(viewer.getByText('# Notes', { exact: false })).toBeVisible();
  await expect(
    viewer.getByRole('heading', { name: 'Notes', exact: true }),
  ).toHaveCount(0);
  await expect(viewer.locator('[data-line][data-selected-line]')).toContainText(
    ['Target source line'],
  );
  await viewer.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(
    viewer.getByRole('heading', { name: 'Notes', exact: true }),
  ).toBeVisible();
});
