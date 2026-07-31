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

interface RegisteredTool {
  execute: (
    id: string,
    params: {
      action: 'list' | 'review' | 'merge' | 'drop';
      incremental?: boolean;
      id?: string;
      force?: boolean;
    },
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
  return captured;
}

async function delegated(
  name: string,
  change?: string,
): Promise<WorktreeRecord> {
  const preparation = await prepareWorktree({ cwd: repository, name });
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
    expect(response).toContain('… and 80 more paths (path list bounded)');
    expect(response).toContain('evidence-path-');
    expect(response.length).toBeLessThan(100_000);
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
      await tool.execute('c2', { action: 'review', id: record.id }),
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
