import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { expect, test } from 'vitest';
import { repository } from './test/worktree-fixture';
import {
  finishWorktree,
  prepareWorktree,
  retireWorktreeSnapshot,
} from './worktree';
import { registerDelegateWorktreesCommand } from './worktrees-command';

test('show guides review and merge through delegate_branches', async () => {
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

  expect(message).toContain(`delegate_branches review ${record.id}`);
  expect(message).toContain(`delegate_branches merge ${record.id}`);
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
  expect(message).toContain(`Cleanup: delegate_branches drop ${record.id}`);
  expect(message).not.toContain('delegate_branches review');
  expect(message).not.toContain('delegate_branches merge');
});
