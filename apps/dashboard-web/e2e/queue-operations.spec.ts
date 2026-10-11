import { expect, test } from '@playwright/test';
import { dashboardTrpcInput, trpcData } from './dashboard-fixtures';
import {
  buildActivityPanelScenario,
  installVisualStateScenario,
} from './visual-state-fixtures';

for (const suffix of ['', ' @desktop']) {
  test(`queue rows reconcile edits, removals, and handoff states${suffix}`, async ({
    page,
  }) => {
    const scenario = buildActivityPanelScenario(true);
    const runtime = scenario.snapshot.runtimes[0];
    if (!runtime) throw new Error('fixture runtime missing');
    scenario.snapshot.runtimes[0] = {
      ...runtime,
      queueDrafts: [
        {
          clientId: 'queue-edit',
          mode: 'steer',
          text: 'change this instruction',
          revision: 1,
        },
        {
          clientId: 'queue-failed',
          mode: 'steer',
          text: 'retryable item',
          revision: 1,
        },
        {
          clientId: 'queue-uncertain',
          mode: 'followUp',
          text: 'outcome is unknown',
          revision: 1,
        },
        {
          clientId: 'queue-remove',
          mode: 'followUp',
          text: 'remove this instruction',
          imageCount: 2,
          revision: 1,
        },
      ],
      queueHandoffs: [
        {
          clientId: 'queue-failed',
          mode: 'steer',
          text: 'retryable item',
          revision: 1,
          status: 'failed',
          detail: 'Pi queue temporarily unavailable',
        },
        {
          clientId: 'queue-uncertain',
          mode: 'followUp',
          text: 'outcome is unknown',
          revision: 1,
          status: 'uncertain',
          detail: 'Delivery outcome could not be confirmed.',
        },
        {
          clientId: 'queue-admitted',
          mode: 'steer',
          text: 'admitted row exists only in handoffs',
          revision: 1,
          status: 'accepted',
        },
      ],
    };
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
    await installVisualStateScenario(page, scenario);
    if (suffix) await page.setViewportSize({ width: 1440, height: 900 });

    const queue = page.getByRole('region', { name: 'Queued messages' });
    await expect(queue).toBeVisible();
    await expect(
      queue.getByRole('img', { name: 'Could not send' }),
    ).toBeVisible();
    await expect(
      queue.getByRole('img', { name: 'Send outcome unknown' }),
    ).toBeVisible();
    const admittedRow = queue.getByRole('group', {
      name: 'Queued steer message: admitted row exists only in handoffs',
    });
    await expect(admittedRow).toBeVisible();
    await expect(
      admittedRow.getByRole('button', { name: 'Edit queued steer message' }),
    ).toBeDisabled();
    await expect(queue).toContainText('Pi queue temporarily unavailable');
    await expect(
      queue
        .getByRole('group', {
          name: /Queued follow-up message: outcome is unknown/,
        })
        .getByRole('button', { name: 'Edit queued follow-up message' }),
    ).toBeDisabled();
    await expect(queue).toContainText('2 images attached');

    const editRow = queue.getByRole('group', {
      name: 'Queued steer message: change this instruction',
    });
    await editRow
      .getByRole('button', { name: 'Edit queued steer message' })
      .click();
    const editor = editRow.getByRole('textbox', {
      name: 'Edit queued steer message',
    });
    await editor.fill('revised instruction');
    await editRow
      .getByRole('button', { name: 'Save queued steer message' })
      .click();
    await expect.poll(() => commands[0]?.type).toBe('queue.update');
    await expect(queue).toContainText('revised instruction');

    await queue
      .getByRole('group', {
        name: /Queued follow-up message: remove this instruction/,
      })
      .getByRole('button', { name: 'Remove queued follow-up message' })
      .click();
    await expect.poll(() => commands[1]?.type).toBe('queue.remove');
    await expect(queue).not.toContainText('remove this instruction');
  });
}
