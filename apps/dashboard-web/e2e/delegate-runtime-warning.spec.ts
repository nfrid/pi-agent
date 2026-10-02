import { expect, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

test('delegate runtime warning preserves the running state', async ({
  page,
}) => {
  const sessionId = 'runtime-warning-session';
  await installDashboardBootstrap(
    page,
    {
      serverId: 'delegate-runtime-warning',
      revision: 1,
      cursor: 1,
      unread: [],
      runtimes: [
        {
          runtimeId: 'warning-runtime',
          ownership: 'external',
          pid: 42,
          cwd: '/tmp',
          liveState: 'working',
          online: true,
          composerCommands: [],
          session: { id: sessionId, entries: [] },
          extensionSurfaces: [],
        },
      ],
      sessions: [
        {
          id: sessionId,
          file: '/tmp/runtime-warning-session.jsonl',
          cwd: '/tmp',
          updatedAt: 1,
        },
      ],
    },
    {
      sessionSnapshot: {
        active: {
          runtimeId: 'warning-runtime',
          runtimeEpoch: 'warning-epoch',
          runtimeSeq: 1,
          liveState: 'working',
          messages: [],
          tools: [],
          truncated: false,
          delegates: [
            {
              runId: 'review-run',
              sessionId: 'review-session',
              lineageId: 'review-lineage',
              name: 'Runtime review worker',
              kind: 'background',
              state: 'running',
              createdAt: 1_800_000_000_000,
              startedAt: 1_800_000_000_000,
              allowWrites: false,
              transcript: [],
            },
          ],
        },
        entries: [
          {
            type: 'custom_message',
            id: 'runtime-warning',
            customType: 'delegate-runtime-warning',
            display: true,
            content: 'The delegate is still working on the requested review.',
            details: {
              identity: 'review@2',
              logicalId: 'review',
              route: 'luna-x',
              startedAt: 1_800_000_000_000,
              elapsedMs: 300_000,
              warningAfterMs: 240_000,
              status: 'warning',
            },
          },
        ],
      },
    },
  );
  for (const [path, data] of [
    ['usage', {}],
    ['settings', {}],
    ['threads', []],
    ['session-threads', []],
  ] as const)
    await page.route(`**/api/${path}`, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(data),
      }),
    );

  await page.route(`**/api/sessions/${sessionId}/delegate-history*`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ version: 2, sessionId, groups: [] }),
    }),
  );
  await page.goto(`/sessions/${sessionId}`);
  const warning = page
    .locator('.session-event')
    .filter({ hasText: 'Delegate runtime warning' });
  await expect(warning).toHaveCount(1);
  await expect(warning).toHaveClass(/event-warning/);
  const icon = warning.locator('.session-event-icon');
  await expect(icon).toHaveText('⚠');
  const [iconColor, orangeColor] = await icon.evaluate((node) => {
    const marker = document.createElement('span');
    marker.style.color = 'var(--orange)';
    document.body.append(marker);
    const colors = [
      getComputedStyle(node).color,
      getComputedStyle(marker).color,
    ];
    marker.remove();
    return colors;
  });
  expect(iconColor).toBe(orangeColor);
  await warning.locator('summary').click();
  await expect(warning).toContainText(
    'The delegate is still working on the requested review.',
  );
  await expect(warning).not.toHaveClass(/event-failed/);
  await expect(page.getByRole('button', { name: 'Abort turn' })).toBeVisible();
  await page.getByRole('button', { name: 'Open session activity' }).click();
  const delegate = page
    .locator('.activity-panel .delegate-row')
    .filter({ hasText: 'Runtime review worker' });
  await expect(delegate).toBeVisible();
  await expect(delegate).toHaveClass(/surface-running/);
  await expect(delegate).not.toHaveClass(/surface-(done|failed)/);
});
