import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ExtensionContext,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeReadSelection,
  processReadSnapshot,
  type ReadSnapshotState,
  reconstructReadSnapshots,
  SNAPSHOT_DETAILS_KEY,
} from './snapshot-reads';
import { clearArtifactRoot, resolveArtifact } from './storage';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'read-snapshot-'));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(clearArtifactRoot));
});

function harness() {
  const entries: Array<Record<string, unknown>> = [];
  const branch: Array<Record<string, unknown>> = [];
  const ctx = {
    cwd: '/repo',
    sessionManager: {
      getSessionId: () => 'snapshot-session',
      getEntries: () => entries,
      getBranch: () => branch,
    },
  } as unknown as ExtensionContext;
  const pi = {
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: 'custom', customType, data });
    },
  };
  return { branch, ctx, entries, pi };
}

function readEvent(
  text: string,
  input: Record<string, unknown> = { path: 'a.txt' },
): ToolResultEvent {
  return {
    type: 'tool_result',
    toolCallId: 'call',
    toolName: 'read',
    input,
    content: [{ type: 'text', text }],
    details: { truncation: undefined },
    isError: false,
  } as ToolResultEvent;
}

function snapshotFrom(result: { details?: unknown } | undefined) {
  return (result?.details as Record<string, unknown>)[SNAPSHOT_DETAILS_KEY] as {
    snapshotId: string;
    handle: string;
    digest: string;
    key: string;
  };
}

describe('snapshot-aware repeated reads', () => {
  it('stores the first exact result and visibly references a verified identical repeat', async () => {
    const directory = await root();
    const h = harness();
    const state: ReadSnapshotState = { byKey: new Map() };
    const first = await processReadSnapshot(
      h.pi,
      h.ctx,
      state,
      readEvent('exact\nbytes\n'),
      directory,
    );
    const snapshot = snapshotFrom(first);
    expect(first?.content?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(
        `snapshot read selection ${snapshot.snapshotId}; exact artifact_retrieve handle=${snapshot.handle}`,
      ),
    });
    expect(
      (
        await resolveArtifact(h.ctx, snapshot.handle, directory)
      )?.bytes.toString(),
    ).toBe('exact\nbytes\n');

    const repeated = await processReadSnapshot(
      h.pi,
      h.ctx,
      state,
      readEvent('exact\nbytes\n'),
      directory,
    );
    expect(repeated?.content).toEqual([
      {
        type: 'text',
        text: `unchanged read selection since ${snapshot.snapshotId}; exact artifact_retrieve handle=${snapshot.handle} mode=lines offset=0`,
      },
    ]);
    expect(repeated?.details).toMatchObject({
      [SNAPSHOT_DETAILS_KEY]: {
        unchanged: true,
        suppressedBytes: 12,
      },
    });
    expect(h.entries).toHaveLength(1);
  });

  it('keeps changed fresh bytes full even when an external mutation could preserve stat data', async () => {
    const directory = await root();
    const h = harness();
    const state: ReadSnapshotState = { byKey: new Map() };
    const first = await processReadSnapshot(
      h.pi,
      h.ctx,
      state,
      readEvent('AAAA'),
      directory,
    );
    const changed = await processReadSnapshot(
      h.pi,
      h.ctx,
      state,
      readEvent('BBBB'),
      directory,
    );
    expect(changed?.content?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('BBBB'),
    });
    expect(changed?.content?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(
        `exact artifact_retrieve handle=${snapshotFrom(changed).handle}`,
      ),
    });
    expect(changed?.details).toMatchObject({
      [SNAPSHOT_DETAILS_KEY]: { unchanged: false, suppressedBytes: 0 },
    });
    expect(h.entries).toHaveLength(2);
    expect(snapshotFrom(changed).digest).not.toBe(snapshotFrom(first).digest);
  });

  it('reports UTF-8 bytes suppressed by an unchanged reference', async () => {
    const directory = await root();
    const h = harness();
    const state: ReadSnapshotState = { byKey: new Map() };
    await processReadSnapshot(h.pi, h.ctx, state, readEvent('π🙂'), directory);
    const repeated = await processReadSnapshot(
      h.pi,
      h.ctx,
      state,
      readEvent('π🙂'),
      directory,
    );
    expect(repeated?.details).toMatchObject({
      [SNAPSHOT_DETAILS_KEY]: { unchanged: true, suppressedBytes: 6 },
    });
  });

  it('keeps fresh results after write, edit, shell, and external-process mutations', async () => {
    const directory = await root();
    const file = path.join(directory, 'mutable.txt');
    const h = harness();
    const state: ReadSnapshotState = { byKey: new Map() };
    const observe = async () =>
      processReadSnapshot(
        h.pi,
        h.ctx,
        state,
        readEvent(await readFile(file, 'utf8'), { path: file }),
        directory,
      );

    await writeFile(file, 'initial');
    await observe();

    // Dedicated write-style replacement.
    await writeFile(file, 'written');
    expect((await observe())?.content?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('written'),
    });

    // Dedicated edit-style exact replacement.
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace('written', 'edited'),
    );
    expect((await observe())?.content?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('edited'),
    });

    // Shell mutation.
    await execFileAsync('/bin/sh', ['-c', 'printf shell > "$1"', 'sh', file]);
    expect((await observe())?.content?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('shell'),
    });

    // Independent external process mutation.
    await execFileAsync(process.execPath, [
      '-e',
      'require("node:fs").writeFileSync(process.argv[1], "external")',
      file,
    ]);
    expect((await observe())?.content?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('external'),
    });
  });

  it('keys exact normalized path/offset/limit selections independently', () => {
    expect(
      normalizeReadSelection('/repo/x', { path: '../a', offset: 2, limit: 3 }),
    ).toBe(normalizeReadSelection('/repo', { path: 'a', offset: 2, limit: 3 }));
    expect(normalizeReadSelection('/repo', { path: 'a' })).not.toBe(
      normalizeReadSelection('/repo', { path: 'a', offset: 2 }),
    );
    expect(normalizeReadSelection('/repo', { path: 'a', offset: 1 })).toBe(
      normalizeReadSelection('/repo', { path: 'a' }),
    );
  });

  it('skips errors and images', async () => {
    const directory = await root();
    const h = harness();
    const state: ReadSnapshotState = { byKey: new Map() };
    const error = { ...readEvent('no'), isError: true } as ToolResultEvent;
    const image = {
      ...readEvent('no'),
      content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }],
    } as ToolResultEvent;
    expect(
      await processReadSnapshot(h.pi, h.ctx, state, error, directory),
    ).toBeUndefined();
    expect(
      await processReadSnapshot(h.pi, h.ctx, state, image, directory),
    ).toBeUndefined();
    expect(h.entries).toHaveLength(0);
  });

  it('fails open with full fresh content when the prior artifact is missing or corrupt', async () => {
    const missingRoot = await root();
    const missing = harness();
    const missingState: ReadSnapshotState = { byKey: new Map() };
    await processReadSnapshot(
      missing.pi,
      missing.ctx,
      missingState,
      readEvent('same'),
      missingRoot,
    );
    await clearArtifactRoot(missingRoot);
    const missingResult = await processReadSnapshot(
      missing.pi,
      missing.ctx,
      missingState,
      readEvent('same'),
      missingRoot,
    );
    expect(missingResult?.content?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('same'),
    });
    expect(missingResult?.content?.[0]).not.toMatchObject({
      text: expect.stringContaining('unchanged read selection'),
    });
    expect(missing.entries).toHaveLength(2);

    const corruptRoot = await root();
    const corrupt = harness();
    const corruptState: ReadSnapshotState = { byKey: new Map() };
    const first = await processReadSnapshot(
      corrupt.pi,
      corrupt.ctx,
      corruptState,
      readEvent('same'),
      corruptRoot,
    );
    const snapshot = snapshotFrom(first);
    await writeFile(
      path.join(
        corruptRoot,
        'blobs',
        snapshot.digest.slice(0, 2),
        snapshot.digest.slice(2),
      ),
      'evil',
    );
    const corruptResult = await processReadSnapshot(
      corrupt.pi,
      corrupt.ctx,
      corruptState,
      readEvent('same'),
      corruptRoot,
    );
    expect(corruptResult?.content?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('same'),
    });
    expect(corruptResult?.content?.[0]).not.toMatchObject({
      text: expect.stringContaining('unchanged read selection'),
    });
  });

  it('reconstructs the latest snapshot details from current-branch read results', async () => {
    const directory = await root();
    const h = harness();
    const initial: ReadSnapshotState = { byKey: new Map() };
    const first = await processReadSnapshot(
      h.pi,
      h.ctx,
      initial,
      readEvent('resume'),
      directory,
    );
    h.branch.push(
      { type: 'compaction', details: {} },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'read',
          details: first?.details,
        },
      },
    );
    const resumed = reconstructReadSnapshots(h.ctx);
    expect(resumed.byKey.size).toBe(1);
    const repeat = await processReadSnapshot(
      h.pi,
      h.ctx,
      resumed,
      readEvent('resume'),
      directory,
    );
    expect((repeat?.content?.[0] as { text: string }).text).toContain(
      `unchanged read selection since ${snapshotFrom(first).snapshotId}; exact artifact_retrieve handle=${snapshotFrom(first).handle}`,
    );
    expect(repeat?.details).toMatchObject({
      [SNAPSHOT_DETAILS_KEY]: { unchanged: true },
    });
  });
});
