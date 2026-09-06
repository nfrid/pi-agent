import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { dispatchDashboardCommand } from '../../../extensions/remote-control/command-dispatcher.js';
import {
  RUNTIME_ABORT_ACTION_ID,
  remoteControlCapabilitySnapshot,
  remoteControlManifest,
} from '../../../extensions/remote-control/contribution.js';
import { QueueDraftStore } from '../../../extensions/remote-control/queue-draft-store.js';
import {
  registerExtensionCapability,
  unregisterExtensionCapability,
} from '../../../extensions/shared/runtime/capability-registry.js';
import { RuntimeService } from '../src/application/runtime-service.js';
import { MetadataStore } from '../src/metadata.js';

it('persists success-only replay for actual queue and semantic action acknowledgements', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-ack-privacy-'));
  const file = path.join(root, 'dashboard.sqlite');
  let metadata = new MetadataStore(file);
  const registry = {
    get: () => undefined,
    sendCommand: vi.fn(async (): Promise<unknown> => undefined),
  };
  let service = new RuntimeService(
    registry as never,
    {} as never,
    {} as never,
    metadata.orchestration,
  );
  const f = {
    registry,
    get metadata() {
      return metadata;
    },
    get service() {
      return service;
    },
    reopen() {
      metadata.close();
      metadata = new MetadataStore(file);
      service = new RuntimeService(
        registry as never,
        {} as never,
        {} as never,
        metadata.orchestration,
      );
    },
  };
  const queue = new QueueDraftStore();
  queue.setSession('session');
  const secret = 'private queue draft';
  const actionSecret = 'private action output '.repeat(100_000);
  registerExtensionCapability({
    id: remoteControlManifest.id,
    manifest: remoteControlManifest,
    capabilities: remoteControlCapabilitySnapshot.capabilities,
    actionHandlers: {
      [RUNTIME_ABORT_ACTION_ID]: () => ({ output: actionSecret }),
    },
  });
  try {
    f.registry.sendCommand.mockImplementation(
      async (_runtimeId?: unknown, command?: unknown) =>
        dispatchDashboardCommand(
          {} as never,
          { isIdle: () => false } as never,
          command as never,
          remoteControlCapabilitySnapshot,
          queue,
        ),
    );
    const commands = [
      {
        id: 'queue-private',
        type: 'queue.add',
        clientId: 'draft-1',
        text: secret,
        mode: 'followUp',
      },
      {
        id: 'action-private',
        type: 'action.invoke',
        actionId: RUNTIME_ABORT_ACTION_ID,
        input: {},
      },
    ] as const;
    expect(
      (await f.service.commandWithReceipt('external', commands[0])).result,
    ).toMatchObject({ draft: { text: secret } });
    expect(
      (await f.service.commandWithReceipt('external', commands[1])).result,
    ).toEqual({ output: actionSecret });
    const rows = f.metadata.db
      .prepare('SELECT result_json FROM command_receipt')
      .all();
    expect(JSON.stringify(rows)).not.toContain('private');
    for (const row of rows)
      expect(Buffer.byteLength(String(row.result_json))).toBeLessThan(64);
    f.reopen();
    for (const command of commands)
      await expect(
        f.service.commandWithReceipt('external', command),
      ).resolves.toMatchObject({
        status: 'already-completed',
        result: { accepted: true },
      });
    expect(f.registry.sendCommand).toHaveBeenCalledTimes(2);
  } finally {
    unregisterExtensionCapability(remoteControlManifest.id);
    metadata.close();
    await rm(root, { recursive: true, force: true });
  }
});
