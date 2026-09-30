import { expect, test } from '@playwright/test';
import {
  assertNoUnexpectedDashboardApiRequests,
  dashboardTrpcInput,
  installDashboardBootstrap,
  trpcData,
} from './dashboard-fixtures';

for (const suffix of ['', ' @desktop']) {
  test(`logical waiting keeps Steer, Later and Abort available${suffix}`, async ({
    page,
  }) => {
    await installDashboardBootstrap(
      page,
      {
        serverId: 'logical-waiting',
        revision: 1,
        cursor: 1,
        unread: [],
        runtimes: [
          {
            runtimeId: 'waiting-runtime',
            ownership: 'external',
            pid: 1,
            cwd: '/tmp',
            liveState: 'waiting',
            online: true,
            composerCommands: [],
            session: { id: 'waiting-session', entries: [] },
            extensionSurfaces: [
              {
                id: 'runtime.settled-background',
                rendererId: 'runtime.settled-background',
                viewModel: { version: 1, count: 0, requestPending: true },
              },
            ],
          },
        ],
        sessions: [
          {
            id: 'waiting-session',
            file: '/tmp/waiting.jsonl',
            cwd: '/tmp',
            updatedAt: 1,
          },
        ],
      },
      { strictApi: true },
    );
    for (const [path, data] of [
      ['usage', {}],
      ['settings', {}],
      ['threads', []],
      ['session-threads', []],
      ['sessions/waiting-session/delegate-history', { version: 2, groups: [] }],
    ] as const)
      await page.route(`**/api/${path}`, (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(data),
        }),
      );
    const commands: Record<string, unknown>[] = [];
    await page.route('**/trpc/runtimeCommand', async (route) => {
      const input = dashboardTrpcInput(route.request());
      const command = input.command as Record<string, unknown>;
      commands.push(command);
      await route.fulfill({
        contentType: 'application/json',
        body: trpcData({
          runtimeId: input.runtimeId,
          commandId: command.id,
          status: 'completed',
          result: { accepted: true },
        }),
      });
    });
    await page.goto('/sessions/waiting-session');
    const editor = page.getByRole('textbox', { name: 'Message Pi' });
    const mode = page.getByRole('button', {
      name: 'Steer current work instead of following up later',
    });
    await expect(editor).toBeEditable();
    await expect(mode).toHaveText('Steer');
    await expect(
      page.getByRole('button', { name: 'Abort turn' }),
    ).toBeVisible();
    await expect(
      page.locator('.composer').getByText('Answer above', { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.locator('.composer').getByText('Prompt', { exact: true }),
    ).toHaveCount(0);
    await editor.fill('Continue the same request');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => commands[0]?.type).toBe('steer');
    await expect(editor).toBeEmpty();
    await mode.click();
    await expect(mode).toHaveText('Later');
    await editor.fill('A new ordinary request');
    await page
      .getByRole('button', { name: 'Queue message', exact: true })
      .click();
    await expect.poll(() => commands[1]?.type).toBe('queue.add');
    expect(commands[1]?.mode).toBe('followUp');
    await expect(editor).toBeEmpty();
    await page.getByRole('button', { name: 'Abort turn' }).click();
    await expect.poll(() => commands[2]?.type).toBe('abort');
    assertNoUnexpectedDashboardApiRequests(page);
  });
}
