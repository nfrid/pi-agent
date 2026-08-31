import { promises as fs, writeFileSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  deriveSessionBranchTopology,
  HISTORY_OVERSCAN_BYTES,
  HISTORY_OVERSCAN_ENTRIES,
  HISTORY_PAGE_BYTES,
  HISTORY_PAGE_ENTRIES,
  SessionIndex,
} from './session-index.js';

describe('session index', () => {
  it('rebuilds from Pi JSONL headers and only reads known IDs', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-sessions-'),
    );
    await mkdir(path.join(root, 'project'));
    const file = path.join(root, 'project', 'session.jsonl');
    const startedAt = '2026-08-12T10:20:30.000Z';
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', version: 3, id: 'session-id', timestamp: startedAt, cwd: '/tmp/project' })}\n${JSON.stringify({ type: 'message', id: 'entry', message: { role: 'user', timestamp: 12345, content: [{ type: 'image', mimeType: 'image/png', data: 'base64-bytes' }] } })}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    expect(index.list()[0]).toMatchObject({
      id: 'session-id',
      file,
      startedAt: Date.parse(startedAt),
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
    await expect(index.readImage('session-id', 'entry', 0)).resolves.toEqual({
      data: Buffer.from('base64-bytes', 'base64'),
      mediaType: 'image/png',
    });
    await expect(
      index.readImage('session-id', 'live-runtime-id', 0, 12345),
    ).resolves.toEqual({
      data: Buffer.from('base64-bytes', 'base64'),
      mediaType: 'image/png',
    });
    await expect(index.readImage('session-id', 'entry', 1)).rejects.toThrow(
      'Unknown session image',
    );
    await appendFile(
      file,
      `${JSON.stringify({ type: 'message', id: 'entry-2', message: { role: 'user', timestamp: 12345, content: [{ type: 'image', mimeType: 'image/png', data: 'second-image' }] } })}\n`,
    );
    await expect(
      index.readImage('session-id', 'live-runtime-id', 0, 12345),
    ).rejects.toThrow('Unknown session image');
  });

  it('projects linked delegate auxiliary sessions without exposing their paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-linked-'));
    const auxiliary = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-linked-aux-'),
    );
    await writeFile(
      path.join(root, 'parent.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'parent', cwd: '/tmp/project' })}\n`,
    );
    const childFile = path.join(auxiliary, 'child.jsonl');
    await writeFile(
      childFile,
      `${JSON.stringify({
        type: 'session',
        id: 'child',
        cwd: '/tmp/project',
        sessionKind: 'delegate',
        name: 'Nested review',
        lineageId: 'lineage',
        parentSessionId: 'parent',
      })}\n`,
    );
    const index = new SessionIndex(root, undefined, undefined, auxiliary);
    await index.rebuild();
    expect(index.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'parent',
          file: path.join(root, 'parent.jsonl'),
        }),
        expect.objectContaining({
          id: 'child',
          file: '',
          sessionKind: 'delegate',
          parentSessionId: 'parent',
          name: 'Nested review',
        }),
      ]),
    );
    expect(index.get('child')).toMatchObject({ id: 'child', file: '' });
    expect(index.isAuxiliary('child')).toBe(true);
  });

  it('does not expose unlinked auxiliary sessions', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-unlinked-'),
    );
    const auxiliary = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-unlinked-aux-'),
    );
    await writeFile(
      path.join(auxiliary, 'child.jsonl'),
      `${JSON.stringify({
        type: 'session',
        id: 'unlinked',
        cwd: '/tmp/project',
        sessionKind: 'delegate',
      })}\n`,
    );
    const index = new SessionIndex(root, undefined, undefined, auxiliary);
    await index.rebuild();
    expect(index.list()).toEqual([]);
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

  it('derives immediate user paths and only marks an explicitly active path', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-topology-'),
    );
    const file = path.join(root, 'topology.jsonl');
    const entries = [
      { type: 'session', id: 'topology-id', cwd: '/tmp' },
      {
        type: 'message',
        id: 'root-prompt',
        parentId: null,
        message: { role: 'user', content: 'Choose a direction', timestamp: 1 },
      },
      {
        type: 'model_change',
        id: 'model-a',
        parentId: 'root-prompt',
        provider: 'test',
        modelId: 'a',
      },
      {
        type: 'branch_summary',
        id: 'summary-a',
        parentId: 'model-a',
        summary: 'prior context',
      },
      {
        type: 'message',
        id: 'path-a-entry',
        parentId: 'summary-a',
        message: {
          role: 'user',
          messageId: 'path-a',
          content: 'Try A',
          timestamp: 10,
        },
      },
      {
        type: 'model_change',
        id: 'model-b',
        parentId: 'root-prompt',
        provider: 'test',
        modelId: 'b',
      },
      {
        type: 'branch_summary',
        id: 'summary-b',
        parentId: 'model-b',
        summary: 'prior context',
      },
      {
        type: 'message',
        id: 'path-b-entry',
        parentId: 'summary-b',
        message: {
          role: 'user',
          messageId: 'path-b',
          content: 'Try B',
          timestamp: 20,
        },
      },
      {
        type: 'thinking_level_change',
        id: 'thinking-c',
        parentId: 'root-prompt',
        thinkingLevel: 'high',
      },
      {
        type: 'message',
        id: 'path-c-entry',
        parentId: 'thinking-c',
        message: {
          role: 'user',
          messageId: 'path-c',
          content: 'Try C',
          timestamp: 30,
        },
      },
      {
        type: 'message',
        id: 'later-c-entry',
        parentId: 'path-c-entry',
        message: {
          role: 'assistant',
          messageId: 'later-c',
          content: 'C answer',
          timestamp: 31,
        },
      },
    ];
    await writeFile(
      file,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();

    const page = await index.readEntries('topology-id');
    expect(page.branchTopology).toEqual({
      points: [
        {
          id: 'root-prompt',
          paths: [
            expect.objectContaining({
              id: 'path-a-entry',
              messageId: 'path-a',
              label: 'Try A',
            }),
            expect.objectContaining({
              id: 'path-b-entry',
              messageId: 'path-b',
              label: 'Try B',
            }),
            expect.objectContaining({
              id: 'path-c-entry',
              messageId: 'path-c',
              label: 'Try C',
              current: false,
            }),
          ],
        },
      ],
    });
    expect(page.branchTopology?.points[0]?.paths).toHaveLength(3);
    expect(page.branchTopology).not.toHaveProperty('activeLeafId');
    expect(
      deriveSessionBranchTopology(entries, 'path-b-entry').points[0]?.paths,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'path-b-entry',
          messageId: 'path-b',
          current: true,
        }),
      ]),
    );
    expect(JSON.stringify(page.branchTopology)).not.toContain('prior context');
  });

  it('returns a complete lightweight outline without transcript payloads', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-outline-'));
    await writeFile(
      path.join(root, 'outline.jsonl'),
      `${[
        { type: 'session', id: 'outline-id', cwd: '/tmp' },
        {
          type: 'message',
          id: 'user-entry',
          message: { role: 'user', content: 'Investigate the parser' },
        },
        {
          type: 'message',
          id: 'assistant-entry',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `Inspecting the parser ${'carefully '.repeat(30)}`,
              },
              {
                type: 'toolCall',
                id: 'tool-call',
                name: 'read',
                arguments: {},
              },
            ],
          },
        },
        {
          type: 'tool',
          id: 'tool-entry',
          tool: { name: 'read', status: 'complete' },
        },
        {
          type: 'message',
          id: 'later-user',
          message: { role: 'user', content: 'Now test it' },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}
`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    const page = await index.readEntries('outline-id');
    expect(page.outline).toEqual([
      expect.objectContaining({
        id: 'user-entry',
        ordinal: 1,
        kind: 'user',
        label: 'Investigate the parser',
      }),
      expect.objectContaining({
        id: 'assistant-entry',
        ordinal: 2,
        kind: 'activity',
        label: expect.stringMatching(/^Inspecting the parser carefully/),
      }),
      expect.objectContaining({
        id: 'later-user',
        ordinal: 4,
        kind: 'user',
        label: 'Now test it',
      }),
    ]);
    expect(
      page.outline?.every((landmark) => landmark.label.length <= 220),
    ).toBe(true);
    expect(JSON.stringify(page.outline)).not.toContain('tool-call');
  });

  it('scans a selected branch while retaining only matching entries', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-selected-branch-'),
    );
    const file = path.join(root, 'selected-branch.jsonl');
    const entries: Record<string, unknown>[] = [
      { type: 'session', id: 'selected-branch-id', cwd: '/tmp' },
    ];
    let parentId: string | null = null;
    for (let index = 0; index < 9; index += 1) {
      const id = `entry-${index}`;
      entries.push({
        type: index === 2 || index === 8 ? 'delegate-candidate' : 'message',
        id,
        parentId,
        message: {
          role: 'assistant',
          content:
            index === 2 || index === 8 ? 'delegate' : 'x'.repeat(600_000),
        },
      });
      parentId = id;
    }
    expect(JSON.stringify(entries[1]).length).toBeGreaterThan(512 * 1024);
    await writeFile(
      file,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();

    const result = await index.readSelectedBranchEntries(
      'selected-branch-id',
      undefined,
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { type?: unknown }).type === 'delegate-candidate',
      { resolveLatestLeaf: true },
    );
    expect(
      result.entries.map((entry) => (entry as { id?: string }).id),
    ).toEqual(['entry-2', 'entry-8']);
    expect(JSON.stringify(result.entries)).not.toContain('x'.repeat(1_024));
    expect(result.entriesTruncated).toBe(false);
    expect(result.leafId).toBe('entry-8');
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

  it('extracts resume metadata only from the latest leaf ancestry', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-resume-meta-'),
    );
    const file = path.join(root, 'resume.jsonl');
    await writeFile(
      file,
      `${[
        { type: 'session', id: 'resume-id', cwd: '/tmp' },
        {
          type: 'message',
          id: 'root',
          parentId: null,
          message: { role: 'user', content: 'Start' },
        },
        {
          type: 'model_change',
          id: 'old-model',
          parentId: 'root',
          provider: 'old-provider',
          modelId: 'old-model',
        },
        {
          type: 'thinking_level_change',
          id: 'old-thinking',
          parentId: 'old-model',
          thinkingLevel: 'high',
        },
        {
          type: 'message',
          id: 'old-answer',
          parentId: 'old-thinking',
          message: {
            role: 'assistant',
            provider: 'old-provider',
            model: 'old-model',
            usage: { totalTokens: 12 },
          },
        },
        {
          type: 'model_change',
          id: 'unselected-branch',
          parentId: 'root',
          provider: 'branch-provider',
          modelId: 'branch-model',
        },
        {
          type: 'message',
          id: 'latest-leaf',
          parentId: 'old-answer',
          message: {
            role: 'assistant',
            provider: 'latest-provider',
            model: 'latest-model',
            usage: { totalTokens: 3456 },
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    expect(index.get('resume-id')).toMatchObject({
      lastKnownModel: { provider: 'latest-provider', model: 'latest-model' },
      lastKnownThinking: 'high',
      lastKnownContextTokens: 3456,
    });
  });

  it('omits missing resume metadata instead of inferring it', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-resume-empty-'),
    );
    await writeFile(
      path.join(root, 'empty.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'empty-id', cwd: '/tmp' })}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    expect(index.get('empty-id')).not.toHaveProperty('lastKnownModel');
    expect(index.get('empty-id')).not.toHaveProperty('lastKnownThinking');
    expect(index.get('empty-id')).not.toHaveProperty('lastKnownContextTokens');
  });

  it('keeps sessions indexed when optional resume ancestry is malformed', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-resume-invalid-'),
    );
    await writeFile(
      path.join(root, 'missing-parent.jsonl'),
      `${[
        { type: 'session', id: 'missing-parent-id', cwd: '/tmp' },
        {
          type: 'model_change',
          id: 'leaf',
          parentId: 'not-present',
          provider: 'test',
          modelId: 'model',
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    );
    await writeFile(
      path.join(root, 'cyclic.jsonl'),
      `${[
        { type: 'session', id: 'cyclic-id', cwd: '/tmp' },
        {
          type: 'model_change',
          id: 'cycle-a',
          parentId: 'cycle-b',
          provider: 'test',
          modelId: 'model',
        },
        {
          type: 'thinking_level_change',
          id: 'cycle-b',
          parentId: 'cycle-a',
          thinkingLevel: 'high',
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    expect(index.get('missing-parent-id')).toMatchObject({
      id: 'missing-parent-id',
    });
    expect(index.get('missing-parent-id')).not.toHaveProperty('lastKnownModel');
    expect(index.get('cyclic-id')).toMatchObject({ id: 'cyclic-id' });
    expect(index.get('cyclic-id')).not.toHaveProperty('lastKnownThinking');
    await expect(
      index.readEntries('missing-parent-id', undefined, 'leaf'),
    ).rejects.toThrow('Invalid session branch');
    await expect(
      index.readEntries('cyclic-id', undefined, 'cycle-b'),
    ).rejects.toThrow('Invalid session branch');
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
        message: {
          role: 'assistant',
          content: 'x'.repeat(HISTORY_PAGE_BYTES + 1),
        },
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
    expect(JSON.stringify(session.entries).length).toBeLessThan(500 * 1024);
    expect(session.history.hasOlder).toBe(true);
    expect(session.history.nextBefore).toBeTruthy();
    expect(session.entries.at(-1)).toMatchObject({ id: 'message-9' });
    expect(session.entries).not.toContainEqual(
      expect.objectContaining({ id: 'message-0' }),
    );
    const older = await index.readEntries(
      'large-id',
      session.history.nextBefore,
    );
    expect(older.history.end).toBe(session.history.start);
    expect(older.history.start).toBeLessThan(older.history.end);
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
        message: {
          role: 'assistant',
          content: 'x'.repeat(HISTORY_PAGE_BYTES + 1),
        },
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
    const immediateOlder = await index.readEntries(
      'paged-id',
      recent.history.nextBefore,
    );
    expect(immediateOlder.history.end).toBe(recent.history.start);
    expect(JSON.stringify(immediateOlder.entries).length).toBeLessThan(
      500 * 1024,
    );
    expect(immediateOlder.entriesComplete).toBe(false);
    let older = immediateOlder;
    while (
      !older.entries.some(
        (entry) => (entry as { id?: string }).id === 'first-user',
      ) &&
      older.history.hasOlder
    ) {
      older = await index.readEntries('paged-id', older.history.nextBefore);
    }
    expect(older.entries).toContainEqual(
      expect.objectContaining({ id: 'first-user' }),
    );
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
    ).toEqual(
      immediateOlder.entries.map((entry) => (entry as { id?: string }).id),
    );
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
        message: {
          role: 'user',
          content: 'x'.repeat(HISTORY_PAGE_BYTES + 1),
        },
      })),
      ...Array.from({ length: 16 }, (_, index) => ({
        type: 'message',
        id: `later-${index}`,
        message: {
          role: 'assistant',
          content: 'y'.repeat(HISTORY_PAGE_BYTES + 1),
        },
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
        .filter((id): id is string =>
          Boolean(id?.startsWith('oversized-user-')),
        ),
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
        if (id?.startsWith('oversized-user-')) seenOmissions.add(id);
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

  it('reads auxiliary delegate sessions by ID without listing or persisting their paths', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-auxiliary-sessions-'),
    );
    const sessions = path.join(root, 'sessions');
    const delegates = path.join(root, '.delegate-sessions');
    await mkdir(sessions);
    await mkdir(delegates);
    await writeFile(
      path.join(sessions, 'main.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'main-id', cwd: '/tmp' })}\n`,
    );
    await writeFile(
      path.join(delegates, 'child.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'child-id', cwd: '/tmp' })}\n${JSON.stringify({ type: 'message', id: 'child-message', message: { role: 'assistant', content: 'working' } })}\n`,
    );
    const saveSession = vi.fn();
    const index = new SessionIndex(
      sessions,
      { saveSession } as never,
      undefined,
      delegates,
    );
    await index.rebuild();

    expect(index.list().map((entry) => entry.id)).toEqual(['main-id']);
    expect(index.isAuxiliary('child-id')).toBe(true);
    const child = await index.readEntries('child-id');
    expect(child).toMatchObject({
      metadata: { id: 'child-id', file: '' },
      entries: [
        { type: 'session', id: 'child-id' },
        { type: 'message', id: 'child-message' },
      ],
    });
    expect(saveSession).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ list: index.list(), child })).not.toContain(
      '.delegate-sessions',
    );
  });

  it('rejects auxiliary session symlinks that escape the configured root', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-auxiliary-symlink-'),
    );
    const sessions = path.join(root, 'sessions');
    const delegates = path.join(root, '.delegate-sessions');
    const outside = path.join(root, 'outside.jsonl');
    await mkdir(sessions);
    await mkdir(delegates);
    await writeFile(
      outside,
      `${JSON.stringify({ type: 'session', id: 'escaped-id', cwd: '/tmp' })}\n`,
    );
    await symlink(outside, path.join(delegates, 'escaped.jsonl'));

    const index = new SessionIndex(sessions, undefined, undefined, delegates);
    await index.rebuild();

    expect(index.get('escaped-id')).toBeUndefined();
    await expect(index.readEntries('escaped-id')).rejects.toThrow(
      'Unknown session.',
    );
  });

  it('only treats auxiliary JSONL watcher events as catalogue inputs', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-watcher-events-'),
    );
    const auxiliary = path.join(root, '.delegate-sessions');
    await mkdir(auxiliary);
    const index = new SessionIndex(root, undefined, undefined, auxiliary);
    const internals = index as unknown as {
      handleWatcherEvent: (
        watcherRoot: string,
        filename: string | Buffer | null | undefined,
      ) => void;
      scheduleIndex: (file: string) => void;
    };
    const scheduleIndex = vi
      .spyOn(internals, 'scheduleIndex')
      .mockImplementation(() => undefined);
    const rebuild = vi.spyOn(index, 'rebuild').mockResolvedValue(undefined);
    try {
      internals.handleWatcherEvent(auxiliary, 'delegate.jsonl');
      internals.handleWatcherEvent(auxiliary, 'delegate.json');
      internals.handleWatcherEvent(auxiliary, 'delegate.json.123.tmp');
      expect(scheduleIndex).toHaveBeenCalledWith(
        path.join(auxiliary, 'delegate.jsonl'),
      );
      expect(rebuild).not.toHaveBeenCalled();

      const normal = path.join(root, 'normal');
      internals.handleWatcherEvent(normal, 'session.json');
      expect(rebuild).toHaveBeenCalledTimes(1);
    } finally {
      scheduleIndex.mockRestore();
      rebuild.mockRestore();
    }
  });

  it('bounds group overscan by bytes and entries when the owner is distant', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-overscan-'),
    );
    const file = path.join(root, 'overscan.jsonl');
    const entries: Record<string, unknown>[] = [
      { type: 'session', id: 'overscan-id', cwd: '/tmp' },
      {
        type: 'message',
        id: 'preamble',
        parentId: null,
        message: {
          role: 'assistant',
          toolCallIds: ['tool-0'],
          content: [{ type: 'text', text: 'Inspecting the large batch.' }],
        },
      },
      ...Array.from({ length: 300 }, (_, index) => ({
        type: 'tool',
        id: `tool-${index}`,
        parentId: index === 0 ? 'preamble' : `tool-${index - 1}`,
        tool: { name: 'read', arguments: { path: 'x'.repeat(2_800) } },
      })),
    ];
    await writeFile(
      file,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    const page = await index.readEntries('overscan-id', undefined, 'tool-299');
    expect(page.history.leadingContinuation).toBe(true);
    expect(page.history.start).toBeGreaterThan(1);
    expect(page.entries.length).toBeLessThanOrEqual(
      HISTORY_PAGE_ENTRIES + HISTORY_OVERSCAN_ENTRIES,
    );
    expect(JSON.stringify(page.entries).length).toBeLessThanOrEqual(
      HISTORY_PAGE_BYTES + HISTORY_OVERSCAN_BYTES + 10_000,
    );
  });

  it('pages sparse pinned branches once and ignores off-branch appends', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-sparse-branch-'),
    );
    const file = path.join(root, 'sparse.jsonl');
    const entries: Record<string, unknown>[] = [
      { type: 'session', id: 'sparse-id', cwd: '/tmp' },
    ];
    let parentId: string | null = null;
    const selectedIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const selectedId = `selected-${index}`;
      selectedIds.push(selectedId);
      entries.push({
        type: 'message',
        id: selectedId,
        parentId,
        message: { role: 'user', content: 's'.repeat(100_000) },
      });
      entries.push({
        type: 'message',
        id: `off-${index}`,
        parentId: null,
        message: { role: 'user', content: 'o'.repeat(100_000) },
      });
      parentId = selectedId;
    }
    await writeFile(
      file,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    const first = await index.readEntries('sparse-id', undefined, 'selected-9');
    const pages = [first.entries];
    let page = first;
    while (page.history.hasOlder) {
      page = await index.readEntries('sparse-id', page.history.nextBefore);
      pages.unshift(page.entries);
    }
    expect(
      pages
        .flat()
        .map((entry) => (entry as { id?: string }).id)
        .filter((id): id is string => id !== undefined),
    ).toEqual(['sparse-id', ...selectedIds]);
    expect(
      pages
        .flat()
        .some((entry) =>
          String((entry as { id?: string }).id).startsWith('off-'),
        ),
    ).toBe(false);
    await appendFile(
      file,
      `${JSON.stringify({ type: 'message', id: 'off-after', parentId: null, message: { role: 'user', content: 'off' } })}\n`,
    );
    const after = await index.readEntries(
      'sparse-id',
      first.history.nextBefore,
    );
    expect(
      after.entries.some((entry) =>
        (entry as { id?: string }).id?.startsWith('off-'),
      ),
    ).toBe(false);
  });

  it('keeps ordinary and pinned-branch cursors valid across an EOF newline append', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-eof-cursor-'),
    );
    const file = path.join(root, 'eof.jsonl');
    const entries: Record<string, unknown>[] = [
      { type: 'session', id: 'eof-id', cwd: '/tmp' },
    ];
    let parentId: string | null = null;
    for (let index = 0; index < 12; index += 1) {
      const id = `eof-entry-${index}`;
      entries.push({
        type: 'message',
        id,
        parentId,
        message: { role: 'user', content: 'x'.repeat(100_000) },
      });
      parentId = id;
    }
    await writeFile(
      file,
      entries.map((entry) => JSON.stringify(entry)).join('\n'),
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    const ordinary = await index.readEntries('eof-id');
    const branch = await index.readEntries('eof-id', undefined, 'eof-entry-11');
    expect(ordinary.history.nextBefore).toBeTruthy();
    expect(branch.history.nextBefore).toBeTruthy();
    const ordinaryBefore = await index.readEntries(
      'eof-id',
      ordinary.history.nextBefore,
    );
    const branchBefore = await index.readEntries(
      'eof-id',
      branch.history.nextBefore,
    );
    await appendFile(
      file,
      `\n${JSON.stringify({
        type: 'message',
        id: 'off-branch-after-eof',
        parentId: null,
        message: { role: 'user', content: 'off branch' },
      })}\n`,
    );
    const ordinaryAfter = await index.readEntries(
      'eof-id',
      ordinary.history.nextBefore,
    );
    const branchAfter = await index.readEntries(
      'eof-id',
      branch.history.nextBefore,
    );
    expect(ordinaryAfter.entries).toEqual(ordinaryBefore.entries);
    expect(branchAfter.entries).toEqual(branchBefore.entries);
  });

  it('builds indexes with bounded source chunks rather than whole-file reads', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-index-chunks-'),
    );
    const file = path.join(root, 'chunks.jsonl');
    await writeFile(
      file,
      `${[
        { type: 'session', id: 'chunks-id', cwd: '/tmp' },
        ...Array.from({ length: 12 }, (_, index) => ({
          type: 'message',
          id: `chunk-${index}`,
          message: { role: 'user', content: 'x'.repeat(40_000) },
        })),
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    );
    let maxPending = 0;
    const readFileSpy = vi.spyOn(fs, 'readFile');
    const index = new SessionIndex(
      root,
      undefined,
      undefined,
      undefined,
      undefined,
      (bytes) => {
        maxPending = Math.max(maxPending, bytes);
      },
    );
    try {
      await index.rebuild();
      expect(readFileSpy).not.toHaveBeenCalled();
      expect(maxPending).toBeLessThanOrEqual(32 * 1024 * 1024 + 64 * 1024);
      expect(index.get('chunks-id')).toBeDefined();
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it('reconstructs reverse pages from bounded descriptor reads and strict v2 cursors', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-indexed-pages-'),
    );
    const file = path.join(root, 'indexed.jsonl');
    const entries = [
      { type: 'session', id: 'indexed-id', cwd: '/tmp' },
      ...Array.from({ length: 8 }, (_, index) => ({
        type: 'message',
        id: `entry-${index}`,
        message: { role: 'user', content: 'x'.repeat(150_000) },
      })),
    ];
    await writeFile(
      file,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    const index = new SessionIndex(root);
    await index.rebuild();
    let page = await index.readEntries('indexed-id');
    const pages = [page.entries.map((entry) => (entry as { id?: string }).id)];
    const firstCursor = page.history.nextBefore;
    expect(firstCursor).toBeTruthy();
    while (page.history.hasOlder) {
      index.resetHistoryReadBytes();
      page = await index.readEntries('indexed-id', page.history.nextBefore);
      expect(index.historyReadBytes).toBeLessThan(500_000);
      pages.unshift(page.entries.map((entry) => (entry as { id?: string }).id));
    }
    expect(pages.flat()).toEqual(entries.map((entry) => entry.id));
    if (!firstCursor) throw new Error('cursor missing');
    const decoded = JSON.parse(
      Buffer.from(firstCursor, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const malformed = Buffer.from(
      JSON.stringify({ ...decoded, extra: true }),
      'utf8',
    ).toString('base64url');
    await expect(index.readEntries('indexed-id', malformed)).rejects.toThrow(
      'Invalid history cursor',
    );
    await appendFile(
      file,
      `${JSON.stringify({ type: 'message', id: 'new-entry', message: { role: 'user', content: 'new' } })}\n`,
    );
    const olderAfterAppend = await index.readEntries('indexed-id', firstCursor);
    expect(
      olderAfterAppend.entries.map((entry) => (entry as { id?: string }).id),
    ).toEqual(pages.at(-2));
    const rewritten = entries.map((entry, index) =>
      index === 1
        ? {
            ...entry,
            message: { role: 'user', content: 'y'.repeat(150_000) },
          }
        : entry,
    );
    writeFileSync(
      file,
      `${rewritten.map((entry) => JSON.stringify(entry)).join('\n')}\n${JSON.stringify({ type: 'message', id: 'new-entry', message: { role: 'user', content: 'new' } })}\n`,
    );
    await expect(index.readEntries('indexed-id', firstCursor)).rejects.toThrow(
      'Stale history cursor',
    );
    const replacement = `${file}.replacement`;
    await rename(file, replacement);
    writeFileSync(
      file,
      `${rewritten.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    await expect(index.readEntries('indexed-id', firstCursor)).rejects.toThrow(
      'Stale history cursor',
    );
  });

  it('rejects a pinned cursor when rewrite and append race descriptor reads', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-read-race-'),
    );
    const file = path.join(root, 'race.jsonl');
    const entries = [
      { type: 'session', id: 'race-indexed-id', cwd: '/tmp' },
      ...Array.from({ length: 10 }, (_, index) => ({
        type: 'message',
        id: `race-entry-${index}`,
        message: { role: 'user', content: 'x'.repeat(120_000) },
      })),
    ];
    const source = () =>
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    await writeFile(file, source());
    let mutate = false;
    let mutated = false;
    const index = new SessionIndex(
      root,
      undefined,
      undefined,
      undefined,
      () => {
        if (!mutate || mutated) return;
        mutated = true;
        const rewritten = entries.map((entry, index) =>
          index === 1
            ? {
                ...entry,
                message: { role: 'user', content: 'y'.repeat(120_000) },
              }
            : entry,
        );
        writeFileSync(
          file,
          `${rewritten.map((entry) => JSON.stringify(entry)).join('\n')}\n${JSON.stringify({ type: 'message', id: 'race-appended', message: { role: 'user', content: 'append' } })}\n`,
        );
      },
    );
    await index.rebuild();
    const recent = await index.readEntries('race-indexed-id');
    expect(recent.history.nextBefore).toBeTruthy();
    mutate = true;
    await expect(
      index.readEntries('race-indexed-id', recent.history.nextBefore),
    ).rejects.toThrow('Stale history cursor');
    expect(mutated).toBe(true);
  });

  it('fans file-watcher changes out to live snapshot observers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-watch-'));
    let changes = 0;
    const index = new SessionIndex(root, undefined, () => {
      changes += 1;
    });
    await index.start();
    // fs.watch may return before the macOS backend is ready to deliver its
    // first event. Keep this as a real watcher test, but cross one timer turn.
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      await writeFile(
        path.join(root, 'watched.jsonl'),
        `${JSON.stringify({ type: 'session', id: 'watched-id', cwd: '/tmp' })}\n`,
      );
      const deadline = Date.now() + 5_000;
      while (!index.get('watched-id') && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(changes).toBeGreaterThan(0);
      expect(index.get('watched-id')).toMatchObject({ id: 'watched-id' });
    } finally {
      index.close();
    }
  }, 10_000);

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
