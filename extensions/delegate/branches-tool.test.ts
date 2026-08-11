import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'vitest';
import { registerDelegateBranchesTool } from './branches-tool';
import { repository } from './test/worktree-fixture';
import {
  finishWorktree,
  prepareWorktree,
  retireWorktreeSnapshot,
  type WorktreeRecord,
} from './worktree';

const PARENT_SESSION = 'parent-session';

interface RegisteredTool {
  execute: (
    id: string,
    params: {
      action: 'list' | 'review' | 'merge' | 'drop';
      scope?: 'session' | 'all';
      incremental?: boolean;
      summaryOnly?: boolean;
      paths?: string[];
      patchBudget?: number;
      id?: string;
      force?: boolean;
    },
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: { sessionManager: { getSessionId: () => string } },
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

function captureTool(): RegisteredTool {
  let captured: RegisteredTool | undefined;
  registerDelegateBranchesTool({
    registerTool(definition: RegisteredTool) {
      captured = definition;
    },
  } as unknown as ExtensionAPI);
  if (!captured) throw new Error('delegate_branches was not registered');
  const definition = captured;
  return {
    ...definition,
    execute: (id, params) =>
      definition.execute(id, params, undefined, undefined, {
        sessionManager: { getSessionId: () => PARENT_SESSION },
      }),
  };
}

async function delegated(
  name: string,
  change?: string,
): Promise<WorktreeRecord> {
  const preparation = await prepareWorktree({
    cwd: repository,
    name,
    parentSessionId: PARENT_SESSION,
  });
  const worktree = preparation.worktree;
  if (!worktree)
    throw new Error(preparation.fallbackReason ?? 'preparation failed');
  if (change)
    writeFileSync(path.join(worktree.record.worktreePath, change), 'work\n');
  return finishWorktree(worktree.record.id, {
    taskName: name,
    outcome: 'success',
  });
}

function body(result: {
  content: Array<{ type: string; text: string }>;
}): string {
  return result.content.map((part) => part.text).join('\n');
}

describe('delegate_branches', () => {
  test('lists what is still outstanding', async () => {
    const tool = captureTool();
    expect(body(await tool.execute('c1', { action: 'list' }))).toBe(
      'No delegate branches.',
    );

    const record = await delegated('First task', 'src/first.txt');
    const listed = await tool.execute('c2', { action: 'list' });
    expect(body(listed)).toContain(record.branch);
    expect(body(listed)).toContain('unmerged');
    expect(listed.details).toMatchObject({
      entries: [{ branch: record.branch, state: 'unmerged' }],
    });
  });

  test('defaults to the current parent session without hiding all history', async () => {
    const tool = captureTool();
    const current = await delegated('Current task', 'src/current.txt');
    const foreignPreparation = await prepareWorktree({
      cwd: repository,
      name: 'Foreign task',
      parentSessionId: 'foreign-session',
    });
    const foreign = foreignPreparation.worktree;
    if (!foreign)
      throw new Error(
        foreignPreparation.fallbackReason ?? 'preparation failed',
      );
    writeFileSync(
      path.join(foreign.record.worktreePath, 'src', 'foreign.txt'),
      'work\n',
    );
    const foreignRecord = await finishWorktree(foreign.record.id, {
      taskName: 'Foreign task',
      outcome: 'success',
    });

    const scoped = await tool.execute('c1', { action: 'list' });
    expect(body(scoped)).toContain(current.branch);
    expect(body(scoped)).not.toContain(foreignRecord.branch);
    expect(scoped.details).toMatchObject({ listScope: 'session' });

    await tool.execute('c2', {
      action: 'drop',
      id: current.id,
      force: true,
    });
    expect(body(await tool.execute('c3', { action: 'list' }))).toBe(
      'No delegate branches.',
    );
    const all = await tool.execute('c4', { action: 'list', scope: 'all' });
    expect(body(all)).toContain(foreignRecord.branch);
    expect(all.details).toMatchObject({ listScope: 'all' });
  });

  test('bounds a large changed-path list while showing omission evidence', async () => {
    const tool = captureTool();
    const preparation = await prepareWorktree({
      cwd: repository,
      name: 'Many changed paths',
    });
    const worktree = preparation.worktree;
    if (!worktree)
      throw new Error(preparation.fallbackReason ?? 'preparation failed');
    for (let index = 0; index < 120; index += 1)
      writeFileSync(
        path.join(
          worktree.record.worktreePath,
          'src',
          `${'evidence-path-'.repeat(8)}${index}.txt`,
        ),
        'work\n',
      );
    const record = await finishWorktree(worktree.record.id, {
      taskName: 'Many changed paths',
      outcome: 'success',
    });

    const response = body(
      await tool.execute('c1', { action: 'review', id: record.id }),
    );
    expect(response).toContain('Changed:   120 paths');
    expect(response).toContain('… and 96 more paths (path list bounded)');
    expect(response).toContain('[patch body omitted');
    expect(response).toContain('set summaryOnly: false or use patchBudget');
    expect(response).toContain('evidence-path-');
    expect(response.length).toBeLessThan(16_000);
  });

  test('supports summary, safe path filtering, and a selected patch budget', async () => {
    const tool = captureTool();
    const selected = 'src/selected;$(not-a-command).txt';
    const record = await delegated('Bounded review', selected);
    writeFileSync(
      path.join(record.worktreePath, 'src', 'other.txt'),
      'other\n',
    );
    await finishWorktree(record.id, {
      taskName: 'Bounded review continuation',
      outcome: 'success',
    });

    const summary = await tool.execute('c1', {
      action: 'review',
      id: record.id,
      summaryOnly: true,
      paths: [selected],
    });
    const summaryBody = body(summary);
    expect(summaryBody).toContain('summaryOnly=yes');
    expect(summaryBody).toContain(
      'Changed paths: total=2; matched=1; omitted=1',
    );
    expect(summaryBody).toContain('[patch body omitted');
    expect(summaryBody).toContain(selected);
    expect(summaryBody).not.toContain('@@');

    const bounded = await tool.execute('c2', {
      action: 'review',
      id: record.id,
      paths: [selected],
      patchBudget: 64,
    });
    expect(body(bounded)).toContain('patchBudget=64 chars');
    expect(body(bounded)).toContain('[review truncated');
    expect(bounded.details).toMatchObject({
      totalChangedPaths: 2,
      matchedChangedPaths: 1,
      omittedChangedPaths: 1,
      patchBudget: 64,
    });

    await expect(
      tool.execute('c3', {
        action: 'review',
        id: record.id,
        paths: ['../outside'],
      }),
    ).rejects.toThrow(/repository-relative/);
    await expect(
      tool.execute('c4', {
        action: 'merge',
        id: record.id,
        patchBudget: 64,
      }),
    ).rejects.toThrow(/only valid for review/);
  });

  test('reviews, merges, then drops', async () => {
    const tool = captureTool();
    const record = await delegated('Full cycle', 'src/added.txt');

    const review = body(
      await tool.execute('c1', { action: 'review', id: record.id }),
    );
    expect(review).toContain(record.branch);
    expect(review).toContain('src/added.txt');

    expect(
      body(await tool.execute('c2', { action: 'merge', id: record.id })),
    ).toMatch(/^Merged /);
    expect(
      body(await tool.execute('c3', { action: 'drop', id: record.id })),
    ).toContain('Dropped');
    expect(existsSync(record.worktreePath)).toBe(false);
  });

  test('selects an incremental review without changing the full default', async () => {
    const tool = captureTool();
    const record = await delegated('Initial task', 'src/initial.txt');
    expect(
      body(await tool.execute('c1', { action: 'merge', id: record.id })),
    ).toMatch(/^Merged /);
    writeFileSync(
      path.join(record.worktreePath, 'src', 'follow-up.txt'),
      'follow-up\n',
    );
    await finishWorktree(record.id, {
      taskName: 'Follow-up fix',
      outcome: 'success',
    });

    const full = body(
      await tool.execute('c2', {
        action: 'review',
        id: record.id,
        summaryOnly: false,
      }),
    );
    const incremental = await tool.execute('c3', {
      action: 'review',
      id: record.id,
      incremental: true,
    });
    expect(full).toContain('src/initial.txt');
    const incrementalBody = body(incremental);
    const incrementalReview = incrementalBody.slice(
      incrementalBody.indexOf('\n\n') + 2,
    );
    expect(incrementalReview).toContain('incremental task delta');
    expect(incrementalReview).toContain('src/follow-up.txt');
    expect(incrementalReview).not.toContain('src/initial.txt');
    expect(incremental.details).toMatchObject({
      action: 'review',
      reviewMode: 'incremental',
    });
  });

  test('guides retired snapshots instead of reviewing or merging them', async () => {
    const tool = captureTool();
    writeFileSync(path.join(repository, 'src', 'value.txt'), 'parent WIP\n');
    const record = await delegated('Snapshot audit');
    await retireWorktreeSnapshot(record.id);

    const review = body(
      await tool.execute('c1', { action: 'review', id: record.id }),
    );
    expect(review).toContain(`Read-only snapshot: ${record.id}`);
    expect(review).toContain(`Cleanup: delegate_branches drop ${record.id}`);
    expect(review).not.toContain('abc123');
    expect(review).toContain('Continue');
    expect(review).not.toContain('Branch:');
    await expect(
      tool.execute('c2', { action: 'merge', id: record.id }),
    ).rejects.toThrow(/not integration work/);
    const displayedId = review.match(
      /Cleanup: delegate_branches drop ([^\s]+)/,
    )?.[1];
    expect(displayedId).toBe(record.id);
    expect(
      body(await tool.execute('c3', { action: 'drop', id: displayedId })),
    ).toContain('Dropped');
  });

  test('refuses to drop unmerged work unless forced', async () => {
    const tool = captureTool();
    const record = await delegated('Unmerged task', 'src/unmerged.txt');
    await expect(
      tool.execute('c1', { action: 'drop', id: record.id }),
    ).rejects.toThrow(/commits would be lost/);
    expect(existsSync(record.worktreePath)).toBe(true);

    await tool.execute('c2', { action: 'drop', id: record.id, force: true });
    expect(existsSync(record.worktreePath)).toBe(false);
  });

  test('requires an id for anything but list', async () => {
    const tool = captureTool();
    await expect(tool.execute('c1', { action: 'review' })).rejects.toThrow(
      /id is required/,
    );
    await expect(
      tool.execute('c2', { action: 'merge', id: 'nope' }),
    ).rejects.toThrow(/No delegate worktree or continuation/);
  });
});
