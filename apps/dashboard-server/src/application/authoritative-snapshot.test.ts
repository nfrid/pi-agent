import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type BridgeEvent,
  parseShellSnapshotResponse,
  type RuntimeSnapshot,
} from '@pi-dashboard/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('can complete a fresh idle registration when its persisted branch is authoritative', async () => {
    const f = await fixture();
    f.register(runtime(f.file, { liveState: 'idle' }));
    const snapshot = await f.app.sessionSnapshot(
      'generation-1',
      'snapshot-session',
    );
    expect(snapshot.completeThroughCursor).toBe(true);
  });

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
        timestamp: 100,
        toolCallIds: ['tool-1'],
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
      { toolCallId: 'tool-1', status: 'running', timestamp: 100 },
    ]);
    expect(snapshot.active.delegates[0]?.transcript[0]?.id).toBe(
      'd'.repeat(300),
    );
  });

  it('keeps a reconnected runtime uncertain after its first lifecycle event', async () => {
    const f = await fixture();
    const reconnected = runtime(f.file);
    f.register(reconnected, 'epoch-reconnected', true);
    f.event(
      reconnected,
      {
        type: 'message.updated',
        sessionId: 'snapshot-session',
        message: {
          messageId: 'replayed-late',
          role: 'assistant',
          content: 'late event',
          phase: 'updated',
        },
      },
      'epoch-reconnected',
      2,
    );

    const snapshot = await f.app.sessionSnapshot(
      'generation-1',
      'snapshot-session',
    );
    expect(snapshot.active.messages).toMatchObject([
      { messageId: 'replayed-late' },
    ]);
    expect(snapshot.completeThroughCursor).toBe(false);
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
        timestamp: 100,
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
      `${JSON.stringify({ type: 'session', id: 'snapshot-session', cwd: '/tmp/snapshot' })}\n${JSON.stringify({ type: 'message', id: 'persisted-terminal', message: { role: 'assistant', content: 'done', timestamp: 100 } })}\n`,
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

  it('retires a live delegate completion once its custom message is durable', async () => {
    const f = await fixture();
    const live = runtime(f.file, { liveState: 'idle' });
    f.register(live);
    const content = '# Background delegate job dj-1 (Review) success';
    f.event(live, {
      type: 'message.finished',
      sessionId: 'snapshot-session',
      message: {
        messageId: 'live-delegate-result',
        role: 'custom',
        content,
        phase: 'finished',
        data: {
          customType: 'delegate-job-result',
          display: true,
          details: { jobs: [{ id: 'dj-1', name: 'Review', state: 'success' }] },
        },
      },
    });

    const liveSnapshot = await f.app.sessionSnapshot(
      'generation-1',
      'snapshot-session',
    );
    expect(liveSnapshot.active.messages).toHaveLength(1);

    await writeFile(
      f.file,
      `${JSON.stringify({ type: 'session', id: 'snapshot-session', cwd: '/tmp/snapshot' })}\n${JSON.stringify(
        {
          type: 'custom_message',
          id: 'persisted-delegate-result',
          customType: 'delegate-job-result',
          content,
          display: true,
          details: {
            jobs: [{ id: 'dj-1', name: 'Review', state: 'success' }],
          },
        },
      )}\n`,
    );
    await f.sessions.refresh([]);

    const durableSnapshot = await f.app.sessionSnapshot(
      'generation-1',
      'snapshot-session',
    );
    expect(durableSnapshot.active.messages).toEqual([]);
    expect(durableSnapshot.entries).toContainEqual(
      expect.objectContaining({
        type: 'custom_message',
        id: 'persisted-delegate-result',
      }),
    );
  });

  it('retires a live background completion once its custom message is durable', async () => {
    const f = await fixture();
    const live = runtime(f.file, { liveState: 'idle' });
    f.register(live);
    const content = 'Background build completed.';
    f.event(live, {
      type: 'message.finished',
      sessionId: 'snapshot-session',
      message: {
        messageId: 'live-background-result',
        role: 'custom',
        content,
        phase: 'finished',
        data: {
          customType: 'background-terminal-result',
          display: true,
          details: { id: 'bg-5', title: 'Build', status: 'completed' },
        },
      },
    });

    const liveSnapshot = await f.app.sessionSnapshot(
      'generation-1',
      'snapshot-session',
    );
    expect(liveSnapshot.active.messages).toHaveLength(1);

    await writeFile(
      f.file,
      `${JSON.stringify({ type: 'session', id: 'snapshot-session', cwd: '/tmp/snapshot' })}\n${JSON.stringify(
        {
          type: 'custom_message',
          id: 'persisted-background-result',
          customType: 'background-terminal-result',
          content,
          display: true,
          details: { id: 'bg-5', title: 'Build', status: 'completed' },
        },
      )}\n`,
    );
    await f.sessions.refresh([]);

    const durableSnapshot = await f.app.sessionSnapshot(
      'generation-1',
      'snapshot-session',
    );
    expect(durableSnapshot.active.messages).toEqual([]);
    expect(durableSnapshot.entries).toContainEqual(
      expect.objectContaining({
        type: 'custom_message',
        id: 'persisted-background-result',
      }),
    );
  });

  it('retires a live delegate wake through the shared custom-message key', async () => {
    const f = await fixture();
    const live = runtime(f.file, { liveState: 'idle' });
    f.register(live);
    const content = '# Delegate wake ready ready';
    const dedupeKey = 'snapshot-session:1:ready';
    f.event(live, {
      type: 'message.finished',
      sessionId: 'snapshot-session',
      message: {
        messageId: 'live-delegate-wake',
        role: 'custom',
        content,
        phase: 'finished',
        data: {
          customType: 'delegate-wake-result',
          display: true,
          details: { dedupeKey, deliveryKey: dedupeKey, wakeId: 'ready' },
        },
      },
    });

    const liveSnapshot = await f.app.sessionSnapshot(
      'generation-1',
      'snapshot-session',
    );
    expect(liveSnapshot.active.messages).toHaveLength(1);

    await writeFile(
      f.file,
      `${JSON.stringify({ type: 'session', id: 'snapshot-session', cwd: '/tmp/snapshot' })}\n${JSON.stringify(
        {
          type: 'custom_message',
          id: 'persisted-delegate-wake',
          customType: 'delegate-wake-result',
          content,
          display: true,
          details: { dedupeKey, deliveryKey: dedupeKey, wakeId: 'ready' },
        },
      )}\n`,
    );
    await f.sessions.refresh([]);

    const durableSnapshot = await f.app.sessionSnapshot(
      'generation-1',
      'snapshot-session',
    );
    expect(durableSnapshot.active.messages).toEqual([]);
    expect(durableSnapshot.entries).toContainEqual(
      expect.objectContaining({
        type: 'custom_message',
        id: 'persisted-delegate-wake',
      }),
    );
  });

  it('does not confuse earlier repeated message or tool content with current durability', async () => {
    const f = await fixture('snapshot-session', [
      { type: 'session', id: 'snapshot-session', cwd: '/tmp/snapshot' },
      {
        type: 'message',
        id: 'old-message',
        message: {
          role: 'assistant',
          content: 'repeated',
          timestamp: 1,
        },
      },
      {
        type: 'custom_message',
        id: 'old-custom',
        customType: 'extension-notice',
        content: 'repeated custom message',
        display: true,
      },
      {
        type: 'tool',
        id: 'old-tool-entry',
        tool: {
          toolCallId: 'old-tool',
          name: 'read',
          arguments: { path: 'same' },
          result: 'same',
          status: 'finished',
        },
      },
    ]);
    const live = runtime(f.file);
    f.register(live);
    f.event(live, {
      type: 'message.finished',
      sessionId: 'snapshot-session',
      message: {
        messageId: 'new-message',
        role: 'assistant',
        content: 'repeated',
        timestamp: 2,
        phase: 'finished',
      },
    });
    f.event(
      live,
      {
        type: 'message.finished',
        sessionId: 'snapshot-session',
        message: {
          messageId: 'new-custom',
          role: 'custom',
          content: 'repeated custom message',
          phase: 'finished',
          data: { customType: 'extension-notice', display: true },
        },
      },
      'epoch-1',
      3,
    );
    f.event(
      live,
      {
        type: 'tool.finished',
        sessionId: 'snapshot-session',
        tool: {
          toolCallId: 'new-tool',
          name: 'read',
          arguments: { path: 'same' },
          result: 'same',
          status: 'finished',
          phase: 'finished',
        },
      },
      'epoch-1',
      4,
    );
    const idle = runtime(f.file, { liveState: 'idle' });
    f.event(
      idle,
      { type: 'agent.settled', sessionId: 'snapshot-session' },
      'epoch-1',
      5,
    );

    const snapshot = await f.app.sessionSnapshot(
      'generation-repeated',
      'snapshot-session',
    );
    expect(snapshot.active.messages).toMatchObject([
      { messageId: 'new-message', phase: 'finished' },
      { messageId: 'new-custom', phase: 'finished' },
    ]);
    expect(snapshot.active.tools).toMatchObject([
      { toolCallId: 'new-tool', phase: 'finished' },
    ]);
    expect(snapshot.completeThroughCursor).toBe(false);
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

  it('does not erase newer active state during a pinned snapshot read', async () => {
    const f = await fixture();
    const live = runtime(f.file);
    f.register(live);
    f.event(live, {
      type: 'message.updated',
      sessionId: 'snapshot-session',
      message: {
        messageId: 'old-live-message',
        role: 'assistant',
        content: 'old',
        phase: 'updated',
      },
    });
    const originalRead = f.sessions.readEntries.bind(f.sessions);
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readSpy = vi
      .spyOn(f.sessions, 'readEntries')
      .mockImplementation(async (...args) => {
        started();
        await releasePromise;
        return originalRead(...args);
      });

    const pending = f.app.sessionSnapshot(
      'generation-pinned',
      'snapshot-session',
      undefined,
      2,
    );
    await startedPromise;
    const newer = runtime(f.file, {
      pendingInteractions: [
        {
          id: 'new-interaction',
          type: 'ask_user',
          question: 'continue?',
          choices: [{ label: 'yes', value: 'yes' }],
          allowCustom: false,
          createdAt: 2,
        },
      ],
      extensionSurfaces: [
        {
          id: 'delegate-surface',
          rendererId: 'delegate.status',
          placement: 'right-rail',
          viewModel: {
            statuses: [
              {
                runId: 'run-new',
                lineageId: 'lineage-new',
                name: 'worker',
                kind: 'background',
                state: 'running',
                createdAt: 2,
                allowWrites: false,
                transcript: [],
              },
            ],
          },
        },
      ],
    });
    f.event(
      newer,
      {
        type: 'message.updated',
        sessionId: 'snapshot-session',
        message: {
          messageId: 'new-live-message',
          role: 'assistant',
          content: 'new',
          phase: 'updated',
        },
      },
      'epoch-1',
      3,
    );
    f.event(
      newer,
      {
        type: 'tool.updated',
        sessionId: 'snapshot-session',
        tool: {
          toolCallId: 'new-tool',
          name: 'read',
          status: 'running',
          phase: 'updated',
        },
      },
      'epoch-1',
      4,
    );
    release();
    const pinned = await pending;
    readSpy.mockRestore();

    // The pinned response may expose only the old capture, but the newer
    // publication must remain in the process-global active projection.
    expect(pinned.active.messages).toMatchObject([
      { messageId: 'old-live-message' },
    ]);
    // The deferred events use the same pinned runtime cut; newer registry
    // provenance must not make the client discard the next event as a
    // duplicate-runtime-seq.
    expect(pinned.runtimeEpoch).toBe('epoch-1');
    expect(pinned.runtimeSeq).toBe(2);
    const current = await f.app.sessionSnapshot(
      'generation-current',
      'snapshot-session',
    );
    expect(current.active.messages).toMatchObject([
      { messageId: 'old-live-message' },
      { messageId: 'new-live-message' },
    ]);
    expect(current.active.tools).toMatchObject([
      { toolCallId: 'new-tool', status: 'running' },
    ]);
    expect(current.active.pendingInteractions).toMatchObject([
      { id: 'new-interaction' },
    ]);
    expect(current.active.delegates).toMatchObject([{ runId: 'run-new' }]);
  });

  it('does not restart a session read for unrelated global events', async () => {
    const f = await fixture();
    f.register(runtime(f.file));
    const originalRead = f.sessions.readEntries.bind(f.sessions);
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readSpy = vi
      .spyOn(f.sessions, 'readEntries')
      .mockImplementation(async (...args) => {
        started();
        await releasePromise;
        return originalRead(...args);
      });

    const pending = f.app.sessionSnapshot(
      'generation-unrelated',
      'snapshot-session',
    );
    await startedPromise;
    release();

    const snapshot = await pending;
    expect(snapshot.cursor).toBe(0);
    expect(readSpy).toHaveBeenCalledTimes(1);
    readSpy.mockRestore();
  });

  it('retries a disk read across a reconnect epoch and bounds shell state', async () => {
    const f = await fixture();
    const first = runtime(f.file);
    f.register(first, 'epoch-old');
    const originalRead = f.sessions.readEntries.bind(f.sessions);
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
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
    expect(parsed.snapshot.cursor).toBe(0);
    expect(parsed.snapshot.runtimes[0]?.session.entries).toEqual([]);
    expect(
      parsed.snapshot.runtimes[0]?.pendingInteractions.length,
    ).toBeLessThanOrEqual(128);
    expect(parsed.snapshot.runtimes[0]?.shellStateTruncated).toBe(true);
  });
});
