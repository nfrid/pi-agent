import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type BridgeEvent,
  parseShellSnapshotResponse,
  type RuntimeSnapshot,
} from '@pi-dashboard/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardEventStream } from '../event-stream.js';
import { MetadataStore } from '../metadata.js';
import type { RuntimeRegistry } from '../runtime-registry.js';
import { SessionIndex } from '../session-index.js';
import { DashboardApplication } from './dashboard-application.js';

interface Fixture {
  root: string;
  file: string;
  app: DashboardApplication;
  sessions: SessionIndex;
  register(
    runtime: RuntimeSnapshot,
    epoch?: string,
    reconnected?: boolean,
  ): void;
  event(
    runtime: RuntimeSnapshot,
    event: BridgeEvent,
    epoch?: string,
    seq?: number,
  ): void;
  offline(runtime: RuntimeSnapshot, epoch?: string, seq?: number): void;
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function fixture(
  sessionId = 'snapshot-session',
  entries: readonly unknown[] = [
    { type: 'session', id: sessionId, cwd: '/tmp/snapshot' },
  ],
): Promise<Fixture> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'dashboard-authoritative-'),
  );
  const sessionDir = path.join(root, 'sessions');
  const file = path.join(sessionDir, `${sessionId}.jsonl`);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    file,
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
  const metadata = new MetadataStore(
    path.join(root, 'state', 'dashboard.sqlite'),
  );
  const sessions = new SessionIndex(sessionDir, metadata);
  let current: RuntimeSnapshot[] = [];
  const provenance = new Map<
    string,
    { runtimeEpoch: string; runtimeSeq: number }
  >();
  const registry = {
    snapshots: () => current.map((runtime) => ({ ...runtime })),
    transportProvenance: (runtimeId: string) => provenance.get(runtimeId),
    close: () => undefined,
  } as unknown as RuntimeRegistry;
  const app = new DashboardApplication({
    registry,
    manager: { onRegistryChange: () => undefined } as never,
    sessions,
    metadata,
    sesh: { list: async () => [] },
    usage: { get: async () => null },
    push: { notify: async () => undefined },
    stateDir: path.join(root, 'state'),
    eventStream: new DashboardEventStream(),
  });
  await app.start();
  const result: Fixture = {
    root,
    file,
    app,
    sessions,
    register(runtime, epoch = 'epoch-1', reconnected = false) {
      current = [runtime];
      provenance.set(runtime.runtimeId, { runtimeEpoch: epoch, runtimeSeq: 1 });
      app.onRegistryChange({
        kind: 'registered',
        snapshot: runtime,
        runtimeEpoch: epoch,
        runtimeSeq: 1,
        ...(reconnected ? { reconnected: true } : {}),
      });
    },
    event(runtime, event, epoch = 'epoch-1', seq = 2) {
      current = [runtime];
      provenance.set(runtime.runtimeId, {
        runtimeEpoch: epoch,
        runtimeSeq: seq,
      });
      app.onRegistryChange({
        kind: 'event',
        runtimeId: runtime.runtimeId,
        event,
        snapshot: runtime,
        runtimeEpoch: epoch,
        runtimeSeq: seq,
      });
    },
    offline(runtime, epoch = 'epoch-1', seq = 4) {
      const offline = { ...runtime, online: false as const };
      current = [offline];
      provenance.set(runtime.runtimeId, {
        runtimeEpoch: epoch,
        runtimeSeq: seq,
      });
      app.onRegistryChange({
        kind: 'offline',
        snapshot: offline,
        runtimeEpoch: epoch,
        runtimeSeq: seq,
      });
    },
  };
  fixtures.push(result);
  return result;
}

function runtime(
  file: string,
  overrides: Partial<RuntimeSnapshot> = {},
): RuntimeSnapshot {
  return {
    runtimeId: 'snapshot-runtime',
    ownership: 'external',
    pid: 1,
    cwd: '/tmp/snapshot',
    liveState: 'working',
    session: {
      id: 'snapshot-session',
      file,
      cwd: '/tmp/snapshot',
      entries: [],
      entriesComplete: false,
    },
    pendingInteractions: [],
    ...overrides,
  };
}

describe('authoritative application snapshot lifecycle', () => {
  it('projects partial assistant, tool, and long-id delegate state', async () => {
    const f = await fixture();
    const live = runtime(f.file, {
      extensionSurfaces: [
        {
          id: 'delegate.status',
          rendererId: 'delegate.status',
          placement: 'right-rail',
          viewModel: {
            statuses: [
              {
                runId: 'run-1',
                lineageId: 'lineage-1',
                name: 'worker',
                kind: 'background',
                state: 'running',
                createdAt: 1,
                allowWrites: false,
                transcript: [
                  {
                    id: 'd'.repeat(300),
                    type: 'thinking',
                    label: 'long identifier',
                    text: 'detail',
                  },
                ],
              },
            ],
          },
        },
      ] as never,
    });
    f.register(live);
    f.event(live, {
      type: 'message.updated',
      sessionId: 'snapshot-session',
      message: {
        messageId: 'assistant-1',
        role: 'assistant',
        content: 'partial',
        phase: 'updated',
      },
    });
    f.event(
      live,
      {
        type: 'tool.updated',
        sessionId: 'snapshot-session',
        tool: {
          toolCallId: 'tool-1',
          name: 'read',
          arguments: { path: 'x' },
          status: 'running',
          phase: 'updated',
        },
      },
      'epoch-1',
      3,
    );
    const snapshot = await f.app.sessionSnapshot(
      'generation-1',
      'snapshot-session',
    );
    expect(snapshot.active.messages).toMatchObject([
      { messageId: 'assistant-1', content: 'partial' },
    ]);
    expect(snapshot.active.tools).toMatchObject([
      { toolCallId: 'tool-1', status: 'running' },
    ]);
    expect(snapshot.active.delegates[0]?.transcript[0]?.id).toBe(
      'd'.repeat(300),
    );
  });

  it('keeps terminal state dirty until disk proves it, then settles old sessions', async () => {
    const f = await fixture();
    const live = runtime(f.file);
    f.register(live);
    f.event(live, {
      type: 'message.finished',
      sessionId: 'snapshot-session',
      message: {
        messageId: 'terminal-1',
        role: 'assistant',
        content: 'done',
        phase: 'finished',
      },
    });
    const idle = runtime(f.file, { liveState: 'idle' });
    f.event(
      idle,
      { type: 'agent.settled', sessionId: 'snapshot-session' },
      'epoch-1',
      3,
    );
    const dirty = await f.app.sessionSnapshot(
      'generation-1',
      'snapshot-session',
    );
    expect(dirty.active.messages).toMatchObject([
      { messageId: 'terminal-1', phase: 'finished' },
    ]);
    expect(dirty.completeThroughCursor).toBe(false);
    f.offline(idle, 'epoch-1', 4);
    const offline = await f.app.sessionSnapshot(
      'generation-1',
      'snapshot-session',
    );
    expect(offline.completeThroughCursor).toBe(false);
    await writeFile(
      f.file,
      `${JSON.stringify({ type: 'session', id: 'snapshot-session', cwd: '/tmp/snapshot' })}\n${JSON.stringify({ type: 'message', id: 'terminal-1', message: { messageId: 'terminal-1', role: 'assistant', content: 'done' } })}\n`,
    );
    await f.sessions.refresh([]);
    const durable = await f.app.sessionSnapshot(
      'generation-1',
      'snapshot-session',
    );
    expect(durable.active.messages).toEqual([]);
    expect(durable.completeThroughCursor).toBe(true);

    const old = await fixture('old-session', [
      { type: 'session', id: 'old-session', cwd: '/tmp/snapshot' },
      {
        type: 'message',
        id: 'old-1',
        message: { role: 'user', content: 'old' },
      },
    ]);
    const oldSnapshot = await old.app.sessionSnapshot(
      'generation-old',
      'old-session',
    );
    expect(oldSnapshot.completeThroughCursor).toBe(true);
    expect(oldSnapshot.active.messages).toEqual([]);
  });

  it('does not overclaim compact runtime fallback, and keeps before pagination separate', async () => {
    const f = await fixture();
    const compact = runtime(f.file);
    f.register(compact);
    await rm(f.file);
    const compactSnapshot = await f.app.sessionSnapshot(
      'generation-1',
      'snapshot-session',
    );
    expect(compactSnapshot.entriesComplete).toBe(false);
    expect(compactSnapshot.completeThroughCursor).toBe(false);

    const paged = await fixture('paged-session', [
      { type: 'session', id: 'paged-session', cwd: '/tmp/snapshot' },
      ...Array.from({ length: 5_000 }, (_, index) => ({
        type: 'message',
        id: `message-${index}`,
        message: { role: 'user', content: `${index}` },
      })),
    ]);
    const page = await paged.app.sessionSnapshot(
      'generation-page',
      'paged-session',
    );
    expect(page.history?.nextBefore).toBeTruthy();
    const older = await paged.app.sessionSnapshot(
      'generation-page',
      'paged-session',
      page.history?.nextBefore,
    );
    expect(older.active.messages).toEqual([]);
    expect(older.completeThroughCursor).toBe(false);
  });

  it('retries a disk read across a reconnect epoch and bounds shell state', async () => {
    const f = await fixture();
    const first = runtime(f.file);
    f.register(first, 'epoch-old');
    const originalRead = f.sessions.readEntries.bind(f.sessions);
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const releasePromise = new Promise<void>((resolve) => (release = resolve));
    const readSpy = vi
      .spyOn(f.sessions, 'readEntries')
      .mockImplementation(async (...args) => {
        started();
        await releasePromise;
        return originalRead(...args);
      });
    const pending = f.app.sessionSnapshot(
      'generation-race',
      'snapshot-session',
    );
    await startedPromise;
    f.app.eventStream.publish((cursor, emittedAt) => ({
      type: 'snapshot',
      cursor,
      emittedAt,
      snapshot: f.app.shellSnapshot('generation-race', 1),
    }));
    const replacement = runtime(f.file, { runtimeId: 'replacement-runtime' });
    f.register(replacement, 'epoch-new', true);
    release();
    const retried = await pending;
    expect(retried.serverId).toBe('generation-race');
    expect(retried.runtimeEpoch).toBe('epoch-new');
    readSpy.mockRestore();

    const waiting = runtime(f.file, {
      liveState: 'waiting',
      pendingInteractions: Array.from({ length: 200 }, () => ({
        id: 'interaction-1',
        type: 'ask_user',
        question: 'q',
        choices: [{ label: 'yes', value: 'yes' }],
        allowCustom: false,
        createdAt: 1,
      })),
      extensionSurfaces: [
        {
          id: 'surface-1',
          rendererId: 'surface-1',
          placement: 'right-rail',
          viewModel: { huge: 'x'.repeat(100_000) },
        },
      ],
    } as never);
    f.register(waiting, 'epoch-new');
    const shell = f.app.shellSnapshot('generation-shell', 7);
    const parsed = parseShellSnapshotResponse({
      snapshot: shell,
      cursor: shell.cursor,
    });
    expect(parsed.snapshot.cursor).toBe(1);
    expect(parsed.snapshot.runtimes[0]?.session.entries).toEqual([]);
    expect(
      parsed.snapshot.runtimes[0]?.pendingInteractions.length,
    ).toBeLessThanOrEqual(128);
    expect(parsed.snapshot.runtimes[0]?.shellStateTruncated).toBe(true);
  });
});
