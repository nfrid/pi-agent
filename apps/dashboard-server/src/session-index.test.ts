import { promises as fs } from 'node:fs';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SessionIndex } from './session-index.js';

describe('session index', () => {
  it('refreshes workspace ownership and removes deleted session files', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-session-refresh-'),
    );
    const directory = path.join(root, 'project');
    await mkdir(directory);
    const file = path.join(directory, 'session.jsonl');
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', id: 'refresh-id', cwd: '/workspace/project' })}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    expect(index.list('workspace-1')).toHaveLength(0);
    await index.refresh([
      {
        id: 'workspace-1',
        name: 'Workspace',
        path: '/workspace',
        canonicalPath: '/workspace',
        source: 'directory',
        active: true,
      },
    ]);
    expect(index.list('workspace-1')).toHaveLength(1);
    await rm(file);
    await index.refresh([
      {
        id: 'workspace-1',
        name: 'Workspace',
        path: '/workspace',
        canonicalPath: '/workspace',
        source: 'directory',
        active: true,
      },
    ]);
    expect(index.get('refresh-id')).toBeUndefined();
  });

  it('rebuilds from Pi JSONL headers and only reads known IDs', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-sessions-'),
    );
    await mkdir(path.join(root, 'project'));
    const file = path.join(root, 'project', 'session.jsonl');
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', version: 3, id: 'session-id', cwd: '/tmp/project' })}\n${JSON.stringify({ type: 'message', id: 'entry', message: { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'base64-bytes' }] } })}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    expect(index.list()[0]).toMatchObject({
      id: 'session-id',
      file,
    });
    expect(index.list()[0]?.entryCount).toBeUndefined();
    await expect(index.readEntries('not-known')).rejects.toThrow(
      'Unknown session',
    );
    const session = await index.readEntries('session-id');
    expect(session).toMatchObject({
      entries: [{ type: 'session' }, { type: 'message' }],
      entriesComplete: true,
      history: { start: 0, end: 2, hasOlder: false },
    });
    expect(session.entries[1]).toMatchObject({
      message: {
        content: [{ type: 'image', mimeType: 'image/png', omitted: true }],
      },
    });
    expect(JSON.stringify(session.entries)).not.toContain('base64-bytes');
  });

  it('filters active history to a valid leaf ancestry and rejects ambiguous leaves', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-branch-'));
    const file = path.join(root, 'branched.jsonl');
    await writeFile(
      file,
      `${[
        { type: 'session', id: 'branched-id', cwd: '/tmp' },
        {
          type: 'message',
          id: 'old-prompt',
          parentId: null,
          message: { role: 'user', content: 'Old prompt' },
        },
        {
          type: 'message',
          id: 'old-answer',
          parentId: 'old-prompt',
          message: { role: 'assistant', content: 'Old answer' },
        },
        {
          type: 'model_change',
          id: 'settings-leaf',
          parentId: null,
          provider: 'openai',
          modelId: 'gpt-5',
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();

    const branch = await index.readEntries(
      'branched-id',
      undefined,
      'settings-leaf',
    );
    expect(
      branch.entries.map((entry) => (entry as { id?: string }).id),
    ).toEqual(['branched-id', 'settings-leaf']);
    expect(branch.entries).not.toContainEqual(
      expect.objectContaining({ id: 'old-prompt' }),
    );
    await expect(
      index.readEntries('branched-id', undefined, 'missing-leaf'),
    ).rejects.toThrow('Invalid session branch');
  });

  it('resolves a working branch leaf from the latest JSONL entry', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-latest-leaf-'),
    );
    const file = path.join(root, 'latest.jsonl');
    await writeFile(
      file,
      `${[
        { type: 'session', id: 'latest-id', cwd: '/tmp' },
        {
          type: 'message',
          id: 'old-prompt',
          parentId: null,
          message: { role: 'user', content: 'Old prompt' },
        },
        {
          type: 'message',
          id: 'old-answer',
          parentId: 'old-prompt',
          message: { role: 'assistant', content: 'Old answer' },
        },
        {
          type: 'message',
          id: 'new-prompt',
          parentId: 'old-answer',
          message: { role: 'user', content: 'New prompt' },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}
`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    const page = await index.readEntries('latest-id', undefined, undefined, {
      resolveLatestLeaf: true,
    });
    expect(page.entries.map((entry) => (entry as { id?: string }).id)).toEqual([
      'latest-id',
      'old-prompt',
      'old-answer',
      'new-prompt',
    ]);
  });

  it('retries latest-leaf reads when the file is appended between passes', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-latest-leaf-race-'),
    );
    const file = path.join(root, 'latest.jsonl');
    const entries = [
      { type: 'session', id: 'race-id', cwd: '/tmp' },
      {
        type: 'message',
        id: 'old-prompt',
        parentId: null,
        message: { role: 'user', content: 'Old prompt' },
      },
      {
        type: 'message',
        id: 'old-answer',
        parentId: 'old-prompt',
        message: { role: 'assistant', content: 'Old answer' },
      },
    ];
    await writeFile(
      file,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();

    const originalStat = fs.stat.bind(fs);
    let statCalls = 0;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
      const result = await originalStat(...args);
      statCalls += 1;
      // The second stat is the first-pass stability check. Append before it
      // returns so the next pass cannot accidentally use the old leaf.
      if (statCalls === 2)
        await appendFile(
          file,
          `${JSON.stringify({
            type: 'message',
            id: 'new-prompt',
            parentId: 'old-answer',
            message: { role: 'user', content: 'New prompt' },
          })}\n`,
        );
      return result;
    });
    try {
      const page = await index.readEntries('race-id', undefined, undefined, {
        resolveLatestLeaf: true,
      });
      expect(
        page.entries.map((entry) => (entry as { id?: string }).id),
      ).toEqual(['race-id', 'old-prompt', 'old-answer', 'new-prompt']);
    } finally {
      statSpy.mockRestore();
    }
    expect(statCalls).toBeGreaterThanOrEqual(5);
  });

  it('returns a bounded recent tail for sessions larger than the response budget', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-large-'));
    const file = path.join(root, 'large.jsonl');
    const entries = [
      { type: 'session', id: 'large-id', cwd: '/tmp' },
      ...Array.from({ length: 10 }, (_, index) => ({
        type: 'message',
        id: `message-${index}`,
        message: { role: 'assistant', content: 'x'.repeat(1024 * 1024) },
      })),
    ];
    await writeFile(
      file,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();

    const session = await index.readEntries('large-id');
    expect(session.entriesComplete).toBe(false);
    expect(session.history.start).toBeGreaterThan(0);
    expect(session.history.end).toBe(11);
    expect(session.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(session.entries).length).toBeLessThanOrEqual(
      8 * 1024 * 1024,
    );
    expect(session.entries.at(-1)).toMatchObject({ id: 'message-9' });
    expect(session.entries).not.toContainEqual(
      expect.objectContaining({ id: 'message-0' }),
    );
  });

  it('loads immediately preceding pages and rejects malformed or stale cursors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-pages-'));
    const firstFile = path.join(root, 'paged.jsonl');
    const secondFile = path.join(root, 'other.jsonl');
    const entries = [
      { type: 'session', id: 'paged-id', cwd: '/tmp' },
      {
        type: 'message',
        id: 'first-user',
        message: { role: 'user', content: 'first request' },
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        type: 'message',
        id: `large-${index}`,
        message: { role: 'assistant', content: 'x'.repeat(1024 * 1024) },
      })),
    ];
    await writeFile(
      firstFile,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    await writeFile(
      secondFile,
      `${JSON.stringify({ type: 'session', id: 'other-id', cwd: '/tmp' })}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();

    const recent = await index.readEntries('paged-id');
    expect(recent.history.hasOlder).toBe(true);
    expect(recent.history.nextBefore).toBeTruthy();
    expect(recent.entries).not.toContainEqual(
      expect.objectContaining({ id: 'first-user' }),
    );
    const older = await index.readEntries(
      'paged-id',
      recent.history.nextBefore,
    );
    expect(older.history.end).toBe(recent.history.start);
    expect(older.entries).toContainEqual(
      expect.objectContaining({ id: 'first-user' }),
    );
    expect(
      older.entries.some(
        (entry) => (entry as { id?: string }).id === 'large-9',
      ),
    ).toBe(false);
    expect(older.entriesComplete).toBe(false);
    await writeFile(
      firstFile,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n${JSON.stringify({ type: 'message', id: 'newer-entry', message: { role: 'assistant', content: 'newer' } })}\n`,
    );
    await index.refresh();
    const olderAfterAppend = await index.readEntries(
      'paged-id',
      recent.history.nextBefore,
    );
    expect(olderAfterAppend.history.end).toBe(recent.history.start);
    expect(
      olderAfterAppend.entries.map((entry) => (entry as { id?: string }).id),
    ).toEqual(older.entries.map((entry) => (entry as { id?: string }).id));
    await expect(index.readEntries('paged-id', 'not-a-cursor')).rejects.toThrow(
      'Invalid history cursor',
    );
    await expect(
      index.readEntries('other-id', recent.history.nextBefore),
    ).rejects.toThrow('Stale history cursor');
  });

  it('pages through an oversized individual entry and terminates', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-oversized-entry-'),
    );
    const file = path.join(root, 'oversized.jsonl');
    const oversizedIds = [
      'oversized-user-0',
      'oversized-user-1',
      'oversized-user-2',
    ];
    const entries = [
      { type: 'session', id: 'oversized-id', cwd: '/tmp' },
      ...oversizedIds.map((id) => ({
        type: 'message',
        id,
        message: { role: 'user', content: 'x'.repeat(9 * 1024 * 1024) },
      })),
      ...Array.from({ length: 16 }, (_, index) => ({
        type: 'message',
        id: `later-${index}`,
        message: { role: 'assistant', content: 'y'.repeat(1024 * 1024) },
      })),
    ];
    await writeFile(
      file,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();

    let page = await index.readEntries('oversized-id');
    const starts = [page.history.start];
    const seenOmissions = new Set(
      page.entries
        .filter(
          (entry) => (entry as { type?: string }).type === 'history_omission',
        )
        .map((entry) => (entry as { id?: string }).id)
        .filter((id): id is string => id !== undefined),
    );
    while (page.history.hasOlder) {
      const before = page.history.nextBefore;
      expect(before).toBeTruthy();
      page = await index.readEntries('oversized-id', before);
      expect(page.history.end).toBe(starts.at(-1));
      expect(page.history.start).toBeLessThan(page.history.end);
      starts.push(page.history.start);
      for (const entry of page.entries) {
        if ((entry as { type?: string }).type !== 'history_omission') continue;
        const id = (entry as { id?: string }).id;
        if (id) seenOmissions.add(id);
      }
    }
    expect(seenOmissions).toEqual(new Set(oversizedIds));
    expect(starts.length).toBeGreaterThan(1);
    expect(starts).toEqual([...starts].sort((a, b) => b - a));
    expect(page.history.nextBefore).toBeUndefined();
  });

  it('accepts compaction entries with a materialized retainedTail', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-retained-tail-'),
    );
    const file = path.join(root, 'compacted.jsonl');
    const retainedTail = [
      {
        type: 'message',
        id: 'tail-message',
        message: { role: 'user', content: 'Continue from here.' },
      },
    ];
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', version: 3, id: 'tail-id', cwd: '/tmp' })}\n${JSON.stringify({ type: 'compaction', id: 'compact-1', summary: 'Earlier work.', retainedTail })}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();

    const session = await index.readEntries('tail-id');
    expect(session.entries[1]).toMatchObject({
      type: 'compaction',
      retainedTail,
    });
  });

  it('uses latest session_info and first user message, not header.name', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-titles-'));
    const file = path.join(root, 'session.jsonl');
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', id: 'title-id', cwd: '/tmp', name: 'Header name' })}\n${JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '  Investigate   the dashboard\n  title  ' }] } })}\n${JSON.stringify({ type: 'session_info', id: 'i1', parentId: 'm1', timestamp: new Date().toISOString(), name: 'Old name' })}\n${JSON.stringify({ type: 'session_info', id: 'i2', parentId: 'i1', timestamp: new Date().toISOString(), name: 'Latest name' })}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    expect(index.get('title-id')).toMatchObject({
      name: 'Latest name',
      title: 'Investigate the dashboard title',
    });
  });

  it('fans file-watcher changes out to live snapshot observers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-watch-'));
    let changed!: () => void;
    const observed = new Promise<void>((resolve) => {
      changed = resolve;
    });
    const index = new SessionIndex(root, undefined, changed);
    await index.start();
    try {
      await writeFile(
        path.join(root, 'watched.jsonl'),
        `${JSON.stringify({ type: 'session', id: 'watched-id', cwd: '/tmp' })}\n`,
      );
      await Promise.race([
        observed,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('Watcher did not publish.')),
            2_000,
          ),
        ),
      ]);
      expect(index.get('watched-id')).toMatchObject({ id: 'watched-id' });
    } finally {
      index.close();
    }
  });

  it('renames a known dormant session by appending session_info', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-rename-'));
    const file = path.join(root, 'session.jsonl');
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', id: 'rename-id', cwd: '/tmp' })}\n${JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'first request' } })}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    await expect(
      index.rename('rename-id', 'Renamed session'),
    ).resolves.toMatchObject({
      id: 'rename-id',
      name: 'Renamed session',
      title: 'first request',
    });
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    const appended = JSON.parse(lines.at(-1) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(appended).toMatchObject({
      type: 'session_info',
      parentId: 'm1',
      name: 'Renamed session',
    });
    expect(typeof appended.id).toBe('string');
    expect(typeof appended.timestamp).toBe('string');
  });
});
