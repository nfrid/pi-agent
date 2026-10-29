import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { expect, test } from 'vitest';
import { repository } from './test/worktree-fixture';
import {
  finishWorktree,
  loadWorktree,
  prepareWorktree,
  retireWorktreeSnapshot,
} from './worktree';
import { writeWorktreeRecord } from './worktree/records';
import { registerDelegateWorktreesCommand } from './worktrees-command';

test('interrupted preparation stays visible with explicit cleanup instead of integration guidance', async () => {
  const prepared = await prepareWorktree({
    cwd: repository,
    name: 'Interrupted setup',
  });
  const record = prepared.worktree?.record;
  if (!record) throw new Error('preparation failed');
  record.status = 'preparing';
  writeWorktreeRecord(record);

  let handler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  registerDelegateWorktreesCommand({
    registerCommand(_name: string, definition: { handler: typeof handler }) {
      handler = definition.handler;
    },
  } as unknown as ExtensionAPI);
  if (!handler) throw new Error('command was not registered');
  const messages: string[] = [];
  const ctx = {
    ui: { notify: (value: string) => messages.push(value) },
  } as unknown as ExtensionCommandContext;
  await handler('list', ctx);
  expect(messages.at(-1)).toContain(record.id);
  expect(messages.at(-1)).toContain('preparing');
  await handler(record.id, ctx);
  expect(messages.at(-1)).toContain('setup is incomplete');
  expect(messages.at(-1)).toContain(`/delegate-worktrees ${record.id} drop`);
  expect(messages.at(-1)).not.toContain('delegate_changes');
  await handler(`${record.id} drop`, ctx);
  expect(loadWorktree(record.id)).toBeUndefined();
});

test('show points change integration back to the workflow node', async () => {
  const prepared = await prepareWorktree({
    cwd: repository,
    name: 'Show task',
  });
  const record = prepared.worktree?.record;
  if (!record) throw new Error(prepared.fallbackReason ?? 'preparation failed');

  let handler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  registerDelegateWorktreesCommand({
    registerCommand(_name: string, definition: { handler: typeof handler }) {
      handler = definition.handler;
    },
  } as unknown as ExtensionAPI);
  if (!handler) throw new Error('command was not registered');

  let message = '';
  const ctx = {
    ui: { notify: (value: string) => (message = value) },
  } as unknown as ExtensionCommandContext;
  await handler(record.id, ctx);

  expect(message).toContain('use delegate_changes with the workflow node');
  expect(message).not.toContain(`git merge ${record.branch}`);
});

test('show gives continuation and drop guidance for retired snapshots', async () => {
  const prepared = await prepareWorktree({
    cwd: repository,
    name: 'Snapshot show',
  });
  const record = prepared.worktree?.record;
  if (!record) throw new Error(prepared.fallbackReason ?? 'preparation failed');
  await finishWorktree(record.id, {
    taskName: 'Snapshot show',
    outcome: 'success',
  });
  await retireWorktreeSnapshot(record.id);

  let handler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  registerDelegateWorktreesCommand({
    registerCommand(_name: string, definition: { handler: typeof handler }) {
      handler = definition.handler;
    },
  } as unknown as ExtensionAPI);
  if (!handler) throw new Error('command was not registered');

  let message = '';
  const ctx = {
    ui: { notify: (value: string) => (message = value) },
  } as unknown as ExtensionCommandContext;
  await handler(record.id, ctx);

  expect(message).toContain('Read-only snapshot:');
  expect(message).toContain(`Cleanup: /delegate-worktrees ${record.id} drop`);
  expect(message).not.toContain('delegate_changes review');
  expect(message).not.toContain('delegate_changes merge');
});
