import { expect, type Page, test } from '@playwright/test';
import {
  dashboardTrpcInput,
  installDashboardBootstrap,
  trpcData,
} from './dashboard-fixtures';

async function navigate(page: Page, sessionId: string) {
  await page.evaluate((id) => {
    window.history.pushState({}, '', `/sessions/${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, sessionId);
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}$`));
}

for (const newerText of ['', 'New text written after returning']) {
  test(`draft lifecycle ACK after navigation ${newerText ? 'preserves newer text' : 'clears the live editor'}`, async ({
    page,
  }) => {
    // All API traffic is intercepted; Vite's unused API target never connects
    // to a daemon, runtime host, or dashboard bridge socket.
    await page.route('**/api/**', (route) =>
      route.fulfill({ status: 404, body: '' }),
    );
    await page.route('**/trpc/**', (route) =>
      route.fulfill({ status: 404, body: '' }),
    );
    await installDashboardBootstrap(page, {
      serverId: 'draft-lifecycle',
      revision: 1,
      cursor: 1,
      runtimes: ['one', 'two'].map((id) => ({
        runtimeId: `runtime-${id}`,
        ownership: 'external' as const,
        pid: 1,
        cwd: '/tmp/draft-lifecycle',
        liveState: 'idle' as const,
        online: true,
        composerCommands: [],
        session: { id, entries: [] },
      })),
      sessions: ['one', 'two'].map((id) => ({
        id,
        file: `/tmp/${id}.jsonl`,
        cwd: '/tmp/draft-lifecycle',
        updatedAt: 1,
      })),
      projects: [],
      checkouts: [],
      threads: [],
      runs: [],
      unread: [],
    });
    let accepted = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/trpc/runtimeCommand', async (route) => {
      const input = dashboardTrpcInput(route.request());
      const command = input.command as Record<string, unknown>;
      expect(command.text).toBe('Submitted text');
      accepted = true;
      await pending;
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
    await page.goto('/sessions/one');
    const editor = page.getByRole('textbox', { name: 'Message Pi' });
    await editor.fill('Submitted text');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => accepted).toBe(true);
    await navigate(page, 'two');
    await expect(editor).toBeEmpty();
    await navigate(page, 'one');
    await expect(editor).toHaveText('Submitted text');
    if (newerText) await editor.fill(newerText);
    const response = page.waitForResponse('**/trpc/runtimeCommand');
    release();
    await response;
    await expect(editor).toHaveText(newerText);
    const send = page.getByRole('button', { name: 'Send', exact: true });
    if (newerText) await expect(send).toBeEnabled();
    else await expect(send).toBeDisabled();
    // Navigating and reloading must not restore a stale editor/debounce copy.
    await navigate(page, 'two');
    await expect(editor).toBeEmpty();
    await navigate(page, 'one');
    await expect(editor).toHaveText(newerText);
    await page.reload();
    await expect(editor).toHaveText(newerText);
  });
}
