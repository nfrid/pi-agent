import {
  createRuntimeCapabilitySnapshot,
  type ExtensionManifest,
} from '@pi-dashboard/extension-contributions';
import { expect, test } from '@playwright/test';
import { dashboardTrpcInput, trpcData } from './dashboard-fixtures';
import {
  buildActivityPanelScenario,
  installVisualStateScenario,
} from './visual-state-fixtures';

const nativeManifest: ExtensionManifest = {
  id: 'native-steering-fixture',
  version: '1',
  title: 'Native steering',
  actions: [
    {
      id: 'queue.steer-now',
      title: 'Send steer now',
      inputSchema: {
        type: 'object',
        properties: {
          clientId: { type: 'string' },
          revision: { type: 'integer', minimum: 1 },
          expectedSessionId: { type: 'string' },
        },
        required: ['clientId', 'revision', 'expectedSessionId'],
        additionalProperties: false,
      },
      availability: {
        requires: ['remote-control.native-steering'],
        liveStates: ['working'],
      },
      idempotent: false,
    },
  ],
  renderers: [],
};

for (const suffix of ['', ' @desktop']) {
  test(`native queue action waits for authoritative entry evidence${suffix}`, async ({
    page,
  }) => {
    const scenario = buildActivityPanelScenario(true);
    const source = scenario.snapshot.runtimes[0];
    if (!source) throw new Error('Fixture runtime missing.');
    const capabilities = (available: boolean) =>
      createRuntimeCapabilitySnapshot(
        [...(source.capabilities?.manifests ?? []), nativeManifest],
        [
          ...(source.capabilities?.capabilities ?? []),
          { id: 'remote-control.native-steering', version: '1', available },
        ],
      );
    const head = {
      clientId: 'native-head',
      mode: 'steer' as const,
      text: 'adjust the current response',
      revision: 2,
    };
    const remaining = [
      {
        clientId: 'later',
        mode: 'followUp' as const,
        text: 'later',
        revision: 1,
      },
      {
        clientId: 'next-steer',
        mode: 'steer' as const,
        text: 'next boundary instruction',
        revision: 1,
      },
    ] as const;
    scenario.snapshot.runtimes[0] = {
      ...source,
      capabilities: capabilities(true),
      queueDrafts: [remaining[0], head, remaining[1]],
      queueHandoffs: [],
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
    const queue = page.getByRole('region', { name: 'Queued messages' });
    const headRow = queue.getByRole('group', {
      name: `Queued steer message: ${head.text}`,
    });
    await expect(
      queue.getByRole('button', { name: 'Send steer now' }),
    ).toHaveCount(1);
    await headRow.getByRole('button', { name: 'Send steer now' }).click();
    await expect.poll(() => commands.length).toBe(1);
    expect(commands[0]).toMatchObject({
      type: 'action.invoke',
      actionId: 'queue.steer-now',
      input: {
        clientId: head.clientId,
        revision: head.revision,
        expectedSessionId: source.session.id,
      },
    });
    // Command success is not context entry, and cannot remove this row.
    await expect(headRow).toBeVisible();
    scenario.snapshot.runtimes[0] = {
      ...source,
      capabilities: capabilities(false),
      queueDrafts: remaining,
      queueHandoffs: [{ ...head, status: 'accepted' }],
    };
    await page.reload();
    await expect(headRow).toBeVisible();
    await expect(
      headRow.getByRole('button', { name: 'Edit queued steer message' }),
    ).toBeDisabled();
    await expect(
      headRow.getByRole('button', { name: 'Remove queued steer message' }),
    ).toBeDisabled();
    await expect(
      queue.getByRole('button', { name: 'Send steer now' }),
    ).toHaveCount(0);

    scenario.snapshot.runtimes[0] = {
      ...source,
      capabilities: capabilities(true),
      queueDrafts: remaining,
      queueHandoffs: [{ ...head, status: 'entered' }],
    };
    await page.reload();
    await expect(headRow).toHaveCount(0);
    await expect(
      queue.getByRole('button', { name: 'Send steer now' }),
    ).toHaveCount(1);
    scenario.snapshot.runtimes[0] = {
      ...source,
      capabilities: capabilities(false),
      queueDrafts: remaining,
      queueHandoffs: [{ ...head, status: 'entered' }],
    };
    await page.reload();
    await expect(
      queue.getByRole('button', { name: 'Send steer now' }),
    ).toHaveCount(0);
    await expect(queue).toContainText('next boundary instruction');
  });
}
