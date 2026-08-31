import { expect, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

const session = {
  id: 'branch-session',
  file: '/tmp/branch-session.jsonl',
  cwd: '/tmp',
  title: 'Branch session',
  updatedAt: 1,
};

const entries = [
  {
    type: 'session',
    id: session.id,
    cwd: session.cwd,
  },
  ...Array.from({ length: 90 }, (_, index) => {
    const choice =
      index === 88 ? 'Try A' : index === 89 ? 'Try B' : `Turn ${index}`;
    const messageId =
      index === 88
        ? 'choice-a'
        : index === 89
          ? 'choice-b'
          : `message-${index}`;
    return {
      type: 'message',
      id: `entry-${index}`,
      parentId: index === 88 || index === 89 ? 'anchor-entry' : undefined,
      message: {
        role: 'user',
        messageId,
        content: choice,
      },
    };
  }),
];

const snapshot = {
  serverId: 'branch-test',
  revision: 1,
  cursor: 1,
  runtimes: [],
  workspaces: [],
  sessions: [session],
  unread: [],
};

test('mobile branch marker opens paths, returns, closes, and stays reachable', async ({
  page,
}) => {
  await installDashboardBootstrap(page, snapshot, {
    sessionSnapshot: {
      entries,
      branchTopology: {
        points: [
          {
            id: 'anchor-entry',
            paths: [
              {
                id: 'entry-88',
                messageId: 'choice-a',
                label: 'Try A',
                current: false,
              },
              {
                id: 'entry-89',
                messageId: 'choice-b',
                label: 'Try B',
                current: false,
              },
            ],
          },
        ],
      },
    },
  });
  await page.goto('/sessions/branch-session');
  await expect(page.locator('.transcript-virtualized')).toHaveCount(1);

  const bubble = page
    .locator('.message-bubble.message-user')
    .filter({ hasText: 'Try A' });
  const bubbleMarker = bubble.getByRole('button', {
    name: 'Show 2 paths from this message',
  });
  await expect(bubbleMarker).toBeVisible();
  const bubbleCount = await bubbleMarker.getAttribute('data-branch-count');
  expect(bubbleCount).toBe('2');
  const bubbleBox = await bubbleMarker.boundingBox();
  expect(bubbleBox?.width ?? 0).toBeGreaterThanOrEqual(36);
  expect(bubbleBox?.height ?? 0).toBeGreaterThanOrEqual(36);

  await bubbleMarker.click();
  const pathsDialog = page.getByRole('dialog', { name: 'Immediate paths' });
  await expect(pathsDialog).toBeVisible();
  await expect(
    pathsDialog.locator('.transcript-branch-path').filter({ hasText: 'Try A' }),
  ).toBeVisible();
  await expect(
    pathsDialog.locator('.transcript-branch-path').filter({ hasText: 'Try B' }),
  ).toBeVisible();

  await pathsDialog
    .getByRole('button', { name: 'Back to Transcript outline' })
    .click();
  const outlineDialog = page.getByRole('dialog', {
    name: 'Transcript outline',
  });
  await expect(outlineDialog).toBeVisible();
  const outlineMarker = outlineDialog
    .locator('.transcript-outline-item')
    .filter({ hasText: 'Try A' })
    .locator('.transcript-outline-branch-indicator');
  await expect(outlineMarker).toHaveCount(1);
  await expect(outlineMarker).toHaveAttribute(
    'data-branch-count',
    bubbleCount ?? '',
  );
  const outlineBox = await outlineMarker.boundingBox();
  expect(outlineBox?.width ?? 0).toBeGreaterThanOrEqual(36);
  expect(outlineBox?.height ?? 0).toBeGreaterThanOrEqual(36);

  await outlineDialog
    .getByRole('button', { name: 'Close Transcript outline' })
    .click();
  await expect(outlineDialog).toHaveCount(0);
});
