import { expect, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

const snapshot = {
  serverId: 'background-watches',
  revision: 1,
  cursor: 1,
  runtimes: [],
  workspaces: [],
  sessions: [
    {
      id: 'watch-session',
      file: '/tmp/watch-session.jsonl',
      cwd: '/tmp',
      updatedAt: 1,
    },
  ],
  unread: [],
};
const entries = [
  {
    type: 'message',
    id: 'request',
    message: { role: 'user', content: 'Check the background server.' },
  },
  {
    type: 'message',
    id: 'launch',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'watch-call',
          name: 'background',
          arguments: {
            action: 'watch',
            id: 'bg-server',
            watch: [
              { contains: 'ready', stream: 'stdout', timeout_seconds: 60 },
            ],
          },
        },
      ],
    },
  },
  {
    type: 'message',
    id: 'watch-result',
    message: {
      role: 'toolResult',
      toolCallId: 'watch-call',
      toolName: 'background',
      content: [{ type: 'text', text: 'Added watch w-ready to bg-server.' }],
      isError: false,
    },
  },
  {
    type: 'custom_message',
    id: 'matched',
    customType: 'background-watch-result',
    display: true,
    content:
      'Background process bg-server watch w-ready matched: "ready"\nEvidence: **ready** ![literal log](https://example.com/not-an-image.png)',
    details: {
      title: 'Dev server',
      id: 'bg-server',
      watchId: 'w-ready',
      status: 'matched',
      contains: 'ready',
      stream: 'stdout',
    },
  },
  {
    type: 'custom_message',
    id: 'timed-out',
    customType: 'background-watch-result',
    display: true,
    content: 'Background process bg-server watch w-health timed_out: "healthy"',
    details: {
      title: 'Dev server',
      id: 'bg-server',
      watchId: 'w-health',
      status: 'timed_out',
      contains: 'healthy',
    },
  },
  {
    type: 'custom_message',
    id: 'completion',
    customType: 'background-terminal-result',
    display: true,
    content:
      'Background process bg-build "Build" failed (exit 7).\nUnmatched watches at exit:\n- w-1: "ready"\n- w-2: "healthy"\nRecent evidence:\nstderr: build failed intentionally',
    details: {
      title: 'Build',
      id: 'bg-build',
      status: 'failed',
      exitCode: 7,
      duration: '2s',
      endedWatches: [
        { id: 'w-1', contains: 'ready' },
        { id: 'w-2', contains: 'healthy' },
      ],
    },
  },
];

for (const viewport of ['mobile', 'desktop']) {
  test(`background watch outcomes and coalesced completion ${viewport === 'desktop' ? '@desktop' : 'mobile'}`, async ({
    page,
  }, testInfo) => {
    await installDashboardBootstrap(page, snapshot, {
      sessionSnapshot: { entries },
    });
    await page.goto('/sessions/watch-session');
    await expect(
      page.getByText('Watching background output', { exact: true }),
    ).toBeVisible();
    const tool = page
      .locator('details.tool-detail')
      .filter({ hasText: 'Watching background output' });
    await tool.locator('summary').first().click();
    await expect(
      tool.getByRole('list', { name: 'Output watches' }),
    ).toContainText('"ready" · stdout · once · deadline 60s');
    await tool.locator('summary').first().click();
    const completion = page
      .locator('.session-event')
      .filter({ hasText: 'Background command failed · Build' });
    await expect(completion).toHaveCount(1);
    await expect(completion.locator('summary')).toContainText(
      '2 unmatched watches',
    );
    await completion.locator('summary').click();
    await expect(completion).toContainText('build failed intentionally');
    await expect(completion).toContainText('w-1: "ready"');
    await expect(completion).toContainText('w-2: "healthy"');
    await expect(
      page
        .locator('.session-event')
        .filter({ hasText: 'Watch ended unmatched' }),
    ).toHaveCount(0);

    const matched = page
      .locator('.session-event')
      .filter({ hasText: 'Output matched · Dev server' });
    await expect(matched).toHaveCount(1);
    await matched.locator('summary').click();
    await expect(matched.locator('pre')).toContainText(
      '**ready** ![literal log]',
    );
    await expect(matched.locator('img, a')).toHaveCount(0);
    const timedOut = page
      .locator('.session-event')
      .filter({ hasText: 'Watch timed out · Dev server' });
    await expect(timedOut).toHaveCount(1);
    await expect(timedOut).toHaveClass(/event-warning/);

    // Native disclosure remains keyboard-operable on both layouts.
    await completion.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(completion).not.toHaveAttribute('open', '');
    await completion.locator('summary').click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('background-watches.png'),
      fullPage: true,
    });
    await page.reload();
    await expect(
      page
        .locator('.session-event')
        .filter({ hasText: 'Background command failed · Build' }),
    ).toHaveCount(1);
  });
}
