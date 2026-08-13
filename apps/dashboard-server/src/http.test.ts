import { EventEmitter } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_SESSION_INDEX_DELTA_ITEMS,
  parseDashboardMessage,
  parseDashboardStreamMessage,
  parseFrame,
  serializeFrame,
} from '@pi-dashboard/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createDashboardServer } from './http.js';
import { MetadataStore } from './metadata.js';
import { SessionIndex } from './session-index.js';

let server: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('dashboard HTTP boundary', () => {
  it('marks all unread notifications through one authenticated request', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-read-all-'),
    );
    const stateDir = path.join(root, 'state');
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir,
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const metadata = new MetadataStore(path.join(stateDir, 'dashboard.sqlite'));
    metadata.addNotification({
      id: 'notification-1',
      kind: 'settled',
      title: 'Finished',
      body: 'Done',
      createdAt: 1,
    });
    metadata.addNotification({
      id: 'notification-2',
      kind: 'waiting',
      title: 'Waiting',
      body: 'Question',
      createdAt: 2,
    });
    metadata.close();

    expect(server.snapshot().unread).toHaveLength(2);
    const origin = `http://127.0.0.1:${server.port}`;
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/notifications/read-all`,
      {
        method: 'POST',
        headers: { Origin: origin, 'x-dashboard-token': 'test-token' },
      },
    );
    expect(response.status).toBe(200);
    expect(server.snapshot().unread).toEqual([]);
  });

  it('keeps the generated browser token stable across daemon restarts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-token-'));
    const options = {
      port: 0,
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    };
    server = await createDashboardServer(options);
    const token = server.token;
    expect(server.socketPath).toBe(path.join(root, 'state', 'bridge.sock'));
    await server.start();
    await server.stop();
    server = await createDashboardServer(options);
    expect(server.token).toBe(token);
  });

  it('authenticates WebSocket clients in the first message, not the URL', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-ws-'));
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const origin = `http://127.0.0.1:${server.port}`;
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: origin },
    });
    const message = new Promise<string>((resolve, reject) => {
      socket.once('message', (value) => resolve(String(value)));
      socket.once('error', reject);
    });
    await new Promise<void>((resolve) => socket.once('open', () => resolve()));
    socket.send(JSON.stringify({ type: 'auth', token: 'test-token' }));
    await expect(message).resolves.toContain('snapshot');
    socket.close();
  });

  it('stops with an authenticated SSE client still open', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-sse-stop-'),
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const response = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
      headers: { 'x-dashboard-token': 'test-token' },
    });
    expect(response.status).toBe(200);
    await expect(
      Promise.race([
        server.stop().then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 2_000),
        ),
      ]),
    ).resolves.toBe(true);
    await response.body?.cancel().catch(() => undefined);
  });

  it('stops with a silent pre-hello bridge client still open', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-bridge-stop-'),
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const bridge = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    await expect(
      Promise.race([
        server.stop().then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 2_000),
        ),
      ]),
    ).resolves.toBe(true);
  });

  it('replays authenticated SSE records and reports expired cursors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-sse-'));
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      eventBufferSize: 1,
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const origin = `http://127.0.0.1:${server.port}`;
    const headers = { Origin: origin, 'x-dashboard-token': 'test-token' };
    const live = await fetch(
      `http://127.0.0.1:${server.port}/api/events?cursor=${server.snapshot().cursor - 1}`,
      { headers },
    );
    expect(live.status).toBe(200);
    const reader = live.body?.getReader();
    expect(reader).toBeTruthy();
    let text = '';
    while (!text.includes('data:')) {
      const next = await reader?.read();
      if (!next || next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    expect(text).toContain('event: dashboard');
    expect(text).toContain('"type":"snapshot"');
    await reader?.cancel();
    const headerReplay = await fetch(
      `http://127.0.0.1:${server.port}/api/events`,
      {
        headers: {
          ...headers,
          'last-event-id': String(server.snapshot().cursor - 1),
        },
      },
    );
    expect(headerReplay.status).toBe(200);
    await headerReplay.body?.cancel();

    await server.refreshWorkspaces();
    await server.refreshWorkspaces();
    const gap = await fetch(
      `http://127.0.0.1:${server.port}/api/events?cursor=0`,
      { headers },
    );
    expect(gap.status).toBe(409);
    await expect(gap.json()).resolves.toMatchObject({ code: 'replay-gap' });
  });

  it('keeps runtime lifecycle SSE records snapshotless across replay', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-lifecycle-'),
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const implementation = server as unknown as {
      eventStream: {
        cursor: number;
        replayAfter(cursor: number): {
          events: readonly Record<string, unknown>[];
        };
      };
    };
    const initialCursor = implementation.eventStream.cursor;
    const waitForCursor = async (cursor: number): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (implementation.eventStream.cursor >= cursor) return;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error(`Timed out waiting for cursor ${cursor}.`);
    };
    const hello = (cwd: string) => ({
      kind: 'event' as const,
      seq: 1,
      event: {
        type: 'runtime.hello' as const,
        protocolVersion: 1 as const,
        snapshot: {
          runtimeId: 'lifecycle-runtime',
          ownership: 'external' as const,
          pid: 1,
          cwd,
          liveState: 'idle' as const,
          session: { id: 'lifecycle-session', entries: [] },
          pendingInteractions: [],
        },
      },
    });
    const connect = async (cwd: string): Promise<net.Socket> => {
      const bridge = net.createConnection(server?.socketPath as string);
      await new Promise<void>((resolve, reject) => {
        bridge.once('connect', resolve);
        bridge.once('error', reject);
      });
      bridge.write(serializeFrame(hello(cwd)));
      return bridge;
    };

    const first = await connect('/tmp/first');
    await waitForCursor(initialCursor + 1);
    first.destroy();
    await waitForCursor(initialCursor + 2);
    const replacement = await connect('/tmp/reconnected');
    await waitForCursor(initialCursor + 3);

    const replay = implementation.eventStream.replayAfter(initialCursor).events;
    expect(replay[0]).toMatchObject({ type: 'snapshot' });
    const lifecycle = replay.slice(1);
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle[0]).toMatchObject({
      event: { type: 'runtime.stateChanged' },
    });
    expect(lifecycle[1]).toMatchObject({
      event: {
        type: 'runtime.hello',
        snapshot: {
          session: { entries: [], entriesComplete: false },
        },
      },
    });
    for (const record of lifecycle)
      expect(record).not.toHaveProperty('snapshot');

    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/events?cursor=${initialCursor}`,
      { headers: { 'x-dashboard-token': 'test-token' } },
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    let text = '';
    const frames: Record<string, unknown>[] = [];
    while (frames.length < replay.length) {
      const next = await reader?.read();
      if (!next || next.done) break;
      text += new TextDecoder().decode(next.value);
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
      }
      text = text.slice(text.lastIndexOf('\n') + 1);
    }
    await reader?.cancel();
    expect(frames).toHaveLength(replay.length);
    expect(frames.slice(1).every((frame) => !('snapshot' in frame))).toBe(true);
    replacement.destroy();
  });

  it('rejects an oversized replay before starting SSE', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-sse-replay-size-'),
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      sseBufferBytes: 1_024,
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const implementation = server as unknown as {
      eventStream: {
        publish(factory: (cursor: number, emittedAt: number) => unknown): {
          cursor: number;
        };
      };
      snapshot(
        cursor?: number,
      ): import('@pi-dashboard/protocol').BrowserSnapshot;
    };
    const oversized = implementation.eventStream.publish(
      (cursor, emittedAt) => ({
        type: 'snapshot',
        cursor,
        emittedAt,
        snapshot: {
          ...implementation.snapshot(cursor),
          usage: 'x'.repeat(2_000),
        },
      }),
    );
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/events?cursor=${oversized.cursor - 1}`,
      { headers: { 'x-dashboard-token': 'test-token' } },
    );
    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({
      code: 'replay-gap',
      reason: 'replay-too-large',
    });
  });

  it('rejects a replay frame larger than the browser parser limit', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-sse-frame-size-'),
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      sseBufferBytes: 4 * 1024 * 1024,
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const implementation = server as unknown as {
      eventStream: {
        publish(factory: (cursor: number, emittedAt: number) => unknown): {
          cursor: number;
        };
      };
      snapshot(
        cursor?: number,
      ): import('@pi-dashboard/protocol').BrowserSnapshot;
    };
    const oversized = implementation.eventStream.publish(
      (cursor, emittedAt) => ({
        type: 'snapshot',
        cursor,
        emittedAt,
        snapshot: {
          ...implementation.snapshot(cursor),
          usage: 'x'.repeat(2 * 1024 * 1024 + 1),
        },
      }),
    );
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/events?cursor=${oversized.cursor - 1}`,
      { headers: { 'x-dashboard-token': 'test-token' } },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'replay-gap',
      reason: 'replay-too-large',
    });
  });

  it('publishes session-index changes as one compact SSE replay record', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-sessions-stream-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    const sessions = new SessionIndex(sessionDir);
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir,
      sessions,
      sesh: { list: async () => [] },
    });
    await server.start();
    const implementation = server as unknown as {
      eventStream: {
        cursor: number;
        replayAfter(cursor: number): {
          events: readonly Record<string, unknown>[];
        };
      };
      snapshot(
        cursor?: number,
      ): import('@pi-dashboard/protocol').BrowserSnapshot;
    };
    const originalSnapshot = implementation.snapshot.bind(server);
    let constructions = 0;
    implementation.snapshot = (cursor) => {
      constructions += 1;
      return originalSnapshot(cursor);
    };
    const before = implementation.eventStream.cursor;
    // An unchanged watcher notification consumes neither a cursor nor a
    // revision.
    server.publishSessionIndexChange();
    server.publishSessionIndexChange();
    expect(implementation.eventStream.cursor).toBe(before);
    await writeFile(
      path.join(sessionDir, 'changed-session.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'changed-session', cwd: '/tmp' })}\n`,
    );
    await sessions.rebuild();
    server.publishSessionIndexChange();
    const replay = implementation.eventStream.replayAfter(before).events;
    expect(replay).toHaveLength(1);
    const record = replay[0];
    expect(record).toMatchObject({
      type: 'sessions',
      cursor: before + 1,
      upsert: [expect.objectContaining({ id: 'changed-session' })],
      remove: [],
    });
    expect(record).not.toHaveProperty('snapshot');
    expect(JSON.stringify(record).length).toBeLessThan(5_000);
    expect(constructions).toBe(0);
    await rm(path.join(sessionDir, 'changed-session.jsonl'));
    await sessions.rebuild();
    server.publishSessionIndexChange();
    const removal = implementation.eventStream.replayAfter(before).events[1];
    expect(removal).toMatchObject({
      type: 'sessions',
      upsert: [],
      remove: ['changed-session'],
    });
  });

  it('falls back to an authoritative snapshot for oversized session deltas', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dash-stream-fallback-'),
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const implementation = server as unknown as {
      application: {
        sessionMetadataDelta: () => {
          upsert: readonly unknown[];
          remove: readonly string[];
        };
      };
      eventStream: {
        cursor: number;
        replayAfter(cursor: number): {
          events: readonly Record<string, unknown>[];
        };
      };
    };
    implementation.application.sessionMetadataDelta = () => ({
      upsert: [],
      remove: Array.from(
        { length: MAX_SESSION_INDEX_DELTA_ITEMS + 1 },
        (_, index) => `removed-${index}`,
      ),
    });
    const before = implementation.eventStream.cursor;
    server.publishSessionIndexChange();
    const record = implementation.eventStream.replayAfter(before).events[0];
    expect(record).toMatchObject({
      type: 'snapshot',
      cursor: before + 1,
      snapshot: { serverId: server.snapshot().serverId },
    });
    expect(() => parseDashboardStreamMessage(record)).not.toThrow();
  });

  it('uses one online runtime consistently for session metadata overlays', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-session-overlay-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'shared-session.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'shared-session', cwd: '/tmp' })}\n`,
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir,
      sesh: { list: async () => [] },
    });
    await server.start();
    const implementation = server as unknown as {
      application: {
        sessionMetadata(
          runtimes: readonly unknown[],
        ): readonly Record<string, unknown>[];
      };
    };
    const sessions = implementation.application.sessionMetadata([
      {
        runtimeId: 'runtime-first',
        online: true,
        session: {
          id: 'shared-session',
          name: 'First name',
          title: 'First title',
        },
      },
      {
        runtimeId: 'runtime-last',
        online: true,
        session: {
          id: 'shared-session',
          name: 'Last name',
          title: 'Last title',
        },
      },
    ]);
    expect(sessions).toEqual([
      expect.objectContaining({
        id: 'shared-session',
        activeRuntimeId: 'runtime-last',
        name: 'Last name',
        title: 'Last title',
      }),
    ]);
  });

  it('constructs one browser snapshot for each changed SSE/legacy update', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-snapshot-count-'),
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const implementation = server as unknown as {
      snapshot(
        cursor?: number,
      ): import('@pi-dashboard/protocol').BrowserSnapshot;
    };
    const originalSnapshot = implementation.snapshot.bind(server);
    let constructions = 0;
    implementation.snapshot = (cursor) => {
      constructions += 1;
      return originalSnapshot(cursor);
    };
    server.publishChange({ type: 'snapshot' });
    expect(constructions).toBe(1);
  });

  it('bounds slow SSE subscribers and resumes queued records after drain', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-sse-backpressure-'),
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      sseBufferBytes: 1_024,
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const implementation = server as unknown as {
      handleSse(
        request: import('node:http').IncomingMessage,
        response: import('node:http').ServerResponse,
        url: URL,
      ): void;
      eventStream: {
        publish(
          factory: (cursor: number, emittedAt: number) => unknown,
        ): unknown;
      };
      snapshot(
        cursor?: number,
      ): import('@pi-dashboard/protocol').BrowserSnapshot;
    };
    const response = new EventEmitter() as unknown as {
      writableEnded: boolean;
      writableLength: number;
      writeHead: (...args: unknown[]) => void;
      flushHeaders: () => void;
      write: (value: string) => boolean;
      destroy: () => void;
    };
    const writes: string[] = [];
    let destroyed = false;
    Object.assign(response, {
      writableEnded: false,
      writableLength: 0,
      writeHead: () => undefined,
      flushHeaders: () => undefined,
      write: (value: string) => {
        writes.push(value);
        return false;
      },
      destroy: () => {
        destroyed = true;
        (response as unknown as EventEmitter).emit('close');
      },
    });
    const request = new EventEmitter() as unknown as {
      url: string;
      headers: Record<string, string>;
    };
    request.url = `/api/events?cursor=${server.snapshot().cursor}`;
    request.headers = {};
    implementation.handleSse(
      request as import('node:http').IncomingMessage,
      response as unknown as import('node:http').ServerResponse,
      new URL(`http://127.0.0.1${request.url}`),
    );
    const publish = () =>
      implementation.eventStream.publish((cursor, emittedAt) => ({
        type: 'snapshot',
        cursor,
        emittedAt,
        snapshot: implementation.snapshot(cursor),
      }));
    publish();
    expect(destroyed).toBe(false);
    expect(writes).toHaveLength(1);
    (response as unknown as EventEmitter).emit('drain');
    expect(writes).toHaveLength(2);
    publish();
    expect(writes).toHaveLength(2);
    for (let index = 0; index < 20 && !destroyed; index += 1) publish();
    expect(destroyed).toBe(true);
    const writesAfterCleanup = writes.length;
    publish();
    expect(writes).toHaveLength(writesAfterCleanup);
  });

  it('suppresses startup changes until one authoritative initial publication', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-startup-order-'),
    );
    let releaseWorkspaces!: () => void;
    let workspacesStarted!: () => void;
    const workspaceStarted = new Promise<void>((resolve) => {
      workspacesStarted = resolve;
    });
    const workspaceRelease = new Promise<void>((resolve) => {
      releaseWorkspaces = resolve;
    });
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: {
        list: async () => {
          workspacesStarted();
          await workspaceRelease;
          return [];
        },
      },
    });
    const startup = server.start();
    await workspaceStarted;
    const bridge = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: {
          type: 'runtime.hello',
          protocolVersion: 1,
          snapshot: {
            runtimeId: 'startup-runtime',
            ownership: 'external',
            pid: 1,
            cwd: '/tmp/project',
            liveState: 'idle',
            session: { id: 'startup-session', entries: [] },
            pendingInteractions: [],
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.snapshot().revision).toBe(0);
    expect(server.snapshot().cursor).toBe(0);
    releaseWorkspaces();
    await startup;
    expect(server.snapshot().revision).toBe(1);
    expect(server.snapshot().cursor).toBe(1);
    bridge.destroy();
  });

  it('cleans up a failed startup so the server can be retried', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-startup-retry-'),
    );
    const sessions = new SessionIndex(path.join(root, 'sessions'));
    const originalStart = sessions.start.bind(sessions);
    let fail = true;
    sessions.start = async (workspaces) => {
      if (fail) {
        fail = false;
        throw new Error('startup failed');
      }
      await originalStart(workspaces);
    };
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sessions,
      sesh: { list: async () => [] },
    });
    await expect(server.start()).rejects.toThrow('startup failed');
    await expect(server.start()).resolves.toBeUndefined();
  });

  it('turns a cursor from a prior daemon generation into a replay gap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-restart-'));
    const options = {
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    };
    server = await createDashboardServer(options);
    await server.start();
    await server.refreshWorkspaces();
    const oldSnapshot = server.snapshot();
    const oldCursor = oldSnapshot.cursor;
    const oldServerId = oldSnapshot.serverId;
    await server.stop();
    server = await createDashboardServer(options);
    await server.start();
    for (const sessionId of ['restart-session-1', 'restart-session-2'])
      server.publishChange({
        type: 'event',
        sessionId,
        event: { type: 'agent.settled', sessionId },
      });
    expect(server.snapshot().cursor).toBeGreaterThan(oldCursor);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/events?cursor=${oldCursor}&serverId=${encodeURIComponent(oldServerId)}`,
      {
        headers: {
          Origin: `http://127.0.0.1:${server.port}`,
          'x-dashboard-token': 'test-token',
        },
      },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'replay-gap',
      reason: 'server-generation-mismatch',
    });
  });

  it('publishes every browser update with the same monotonic revision as its snapshot', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-revision-'),
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const origin = `http://127.0.0.1:${server.port}`;
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: origin },
    });
    const messages: string[] = [];
    socket.on('message', (value) => messages.push(String(value)));
    await new Promise<void>((resolve) => socket.once('open', resolve));
    socket.send(JSON.stringify({ type: 'auth', token: 'test-token' }));
    const waitForMessage = async (): Promise<Record<string, unknown>> => {
      while (messages.length === 0)
        await new Promise((resolve) => setTimeout(resolve, 1));
      const message = messages.shift();
      if (!message) throw new Error('Expected a websocket message.');
      return JSON.parse(message) as Record<string, unknown>;
    };
    const initial = await waitForMessage();
    const initialSnapshot = initial.snapshot as { revision: number };
    expect(initial.type).toBe('snapshot');
    expect(initialSnapshot.revision).toBe(server.snapshot().revision);
    const bridge = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    const hello = {
      type: 'runtime.hello' as const,
      protocolVersion: 1,
      snapshot: {
        runtimeId: 'revision-runtime',
        ownership: 'external' as const,
        pid: 1,
        cwd: '/tmp',
        liveState: 'idle' as const,
        session: {
          id: 'revision-session',
          entries: [{ type: 'message', message: { role: 'user' } }],
        },
        pendingInteractions: [],
      },
    };
    bridge.write(serializeFrame({ kind: 'event', seq: 1, event: hello }));
    const registration = await waitForMessage();
    expect(registration.type).toBe('snapshot');
    const registrationSnapshot = registration.snapshot as { revision: number };
    expect(registrationSnapshot.revision).toBeGreaterThan(
      initialSnapshot.revision,
    );
    expect(server.snapshot().runtimes[0]?.session.entries).toEqual([]);
    const implementation = server as unknown as {
      snapshot(
        cursor?: number,
      ): import('@pi-dashboard/protocol').BrowserSnapshot;
    };
    const originalSnapshot = implementation.snapshot.bind(server);
    let routineSnapshotConstructions = 0;
    implementation.snapshot = (cursor) => {
      routineSnapshotConstructions += 1;
      return originalSnapshot(cursor);
    };
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 2,
        event: { type: 'runtime.stateChanged', state: 'working' },
      }),
    );
    const update = await waitForMessage();
    expect(update.type).toBe('event');
    expect(update.snapshot).toBeUndefined();
    expect(routineSnapshotConstructions).toBe(0);
    expect(() => parseDashboardMessage(update)).not.toThrow();
    expect(Object.keys(update).sort()).toEqual([
      'event',
      'revision',
      'runtimeId',
      'serverId',
      'type',
    ]);
    expect(update.revision).toBeGreaterThan(registrationSnapshot.revision);
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 3,
        event: {
          type: 'message.updated',
          sessionId: 'revision-session',
          message: { id: 'message-1', role: 'assistant' },
        },
      }),
    );
    const transcriptDelta = await waitForMessage();
    expect(transcriptDelta.type).toBe('event');
    expect(transcriptDelta.snapshot).toBeUndefined();
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 4,
        event: { type: 'runtime.goodbye' },
      }),
    );
    const goodbye = await waitForMessage();
    expect((goodbye.snapshot as { runtimes: unknown[] }).runtimes).toHaveLength(
      0,
    );
    await server.refreshWorkspaces();
    expect(server.snapshot().revision).toBeGreaterThan(
      update.revision as number,
    );
    bridge.destroy();
    socket.close();
  });

  it('marks stale indexed history incomplete for an active branch and contains unknown-session failures', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-active-session-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'not-indexed-yet.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'not-indexed-yet', cwd: '/tmp/project' })}\n${JSON.stringify({ type: 'message', id: 'stale-disk-entry' })}\n`,
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir,
      sesh: { list: async () => [] },
    });
    await server.start();
    const bridge = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: {
          type: 'runtime.hello',
          protocolVersion: 1,
          snapshot: {
            runtimeId: 'external-runtime',
            ownership: 'external',
            pid: 123,
            cwd: '/tmp/project',
            liveState: 'idle',
            session: {
              id: 'live-session',
              name: 'Live session',
              entriesComplete: true,
              entries: [{ type: 'message', id: 'one' }],
            },
            pendingInteractions: [],
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const origin = `http://127.0.0.1:${server.port}`;
    const headers = { Origin: origin, 'x-dashboard-token': 'test-token' };
    const active = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/live-session`,
      { headers },
    );
    expect(active.status).toBe(200);
    expect(await active.json()).toMatchObject({
      metadata: { id: 'live-session', name: 'Live session' },
      entries: [{ type: 'message', id: 'one' }],
      entriesComplete: true,
      runtimeEpoch: expect.any(String),
      runtimeSeq: 1,
    });
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 2,
        event: {
          type: 'session.changed',
          session: {
            id: 'not-indexed-yet',
            name: 'Pending session',
            leafId: 'stale-disk-entry',
            entriesComplete: false,
            entries: [],
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pending = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/not-indexed-yet`,
      { headers },
    );
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({
      entries: [
        { type: 'session', id: 'not-indexed-yet' },
        { type: 'message', id: 'stale-disk-entry' },
      ],
      entriesComplete: false,
      metadata: { id: 'not-indexed-yet', name: 'Pending session' },
    });
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 3,
        event: {
          type: 'session.changed',
          session: {
            id: 'not-indexed-yet',
            leafId: 'missing-leaf',
            entriesComplete: false,
            entries: [],
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const ambiguous = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/not-indexed-yet`,
      { headers },
    );
    expect(ambiguous.status).toBe(200);
    expect(await ambiguous.json()).toMatchObject({
      entries: [],
      entriesComplete: false,
      metadata: { id: 'not-indexed-yet', activeRuntimeId: 'external-runtime' },
    });
    const missing = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/missing`,
      { headers },
    );
    expect(missing.status).toBe(400);
    expect(
      (await fetch(`http://127.0.0.1:${server.port}/api/health`)).status,
    ).toBe(200);
    bridge.destroy();
  });

  it('uses the current JSONL leaf for working runtime snapshots', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-working-freshness-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'working.jsonl'),
      `${[
        { type: 'session', id: 'working-session', cwd: '/tmp/project' },
        { type: 'model_change', id: 'setup', parentId: null },
        {
          type: 'message',
          id: 'first-user',
          parentId: 'setup',
          message: { role: 'user', content: 'First request' },
        },
        {
          type: 'message',
          id: 'latest-user',
          parentId: 'first-user',
          message: { role: 'user', content: 'Latest request' },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}
`,
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      socketPath: path.join(root, 'bridge.sock'),
      sessionDir,
      sesh: { list: async () => [] },
    });
    await server.start();
    const bridge = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: {
          type: 'runtime.hello',
          protocolVersion: 1,
          snapshot: {
            runtimeId: 'working-runtime',
            ownership: 'external',
            pid: 123,
            cwd: '/tmp/project',
            liveState: 'working',
            session: {
              id: 'working-session',
              entriesComplete: true,
              entries: [
                { type: 'model_change', id: 'setup' },
                { type: 'thinking_level_change', thinkingLevel: 'medium' },
              ],
            },
            pendingInteractions: [],
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/working-session`,
      { headers: { 'x-dashboard-token': 'test-token' } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      entries: [
        { type: 'session', id: 'working-session' },
        { type: 'model_change', id: 'setup' },
        { type: 'message', id: 'first-user' },
        { type: 'message', id: 'latest-user' },
      ],
      entriesComplete: true,
      metadata: { activeRuntimeId: 'working-runtime' },
    });
    bridge.destroy();
  });

  it('reads the persisted idle branch after a bounded runtime invalidation', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-idle-invalidation-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, 'idle.jsonl');
    const startedAt = '2026-08-12T10:20:30.000Z';
    await writeFile(
      sessionFile,
      `${[
        {
          type: 'session',
          id: 'idle-session',
          timestamp: startedAt,
          cwd: '/tmp/project',
        },
        { type: 'model_change', id: 'setup', parentId: null },
        {
          type: 'message',
          id: 'persisted-user',
          parentId: 'setup',
          message: { role: 'user', content: 'Persisted request' },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      socketPath: path.join(root, 'bridge.sock'),
      sessionDir,
      sesh: { list: async () => [] },
    });
    await server.start();
    const bridge = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    const indexedUpdatedAt = (await stat(sessionFile)).mtimeMs;
    const helloSession = {
      id: 'idle-session',
      file: sessionFile,
      cwd: '/tmp/project',
      entriesComplete: true,
      entries: [
        {
          type: 'message',
          id: 'stale-runtime-entry',
          message: { role: 'user', content: 'Stale runtime branch' },
        },
      ],
    };
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: {
          type: 'runtime.hello',
          protocolVersion: 1,
          snapshot: {
            runtimeId: 'idle-invalidation-runtime',
            ownership: 'external',
            pid: 123,
            cwd: '/tmp/project',
            liveState: 'idle',
            session: helloSession,
            pendingInteractions: [],
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const headers = { 'x-dashboard-token': 'test-token' };
    const before = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/idle-session`,
      { headers },
    );
    expect(await before.json()).toMatchObject({
      entries: [{ id: 'stale-runtime-entry' }],
      entriesComplete: true,
      metadata: {
        startedAt: Date.parse(startedAt),
        updatedAt: indexedUpdatedAt,
      },
    });
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 2,
        event: {
          type: 'runtime.stateChanged',
          state: 'idle',
          snapshot: {
            session: {
              id: 'idle-session',
              file: sessionFile,
              cwd: '/tmp/project',
              entries: [],
              entriesComplete: false,
              leafId: 'persisted-user',
            },
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const after = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/idle-session`,
      { headers },
    );
    expect(await after.json()).toMatchObject({
      entries: [
        { type: 'session', id: 'idle-session' },
        { type: 'model_change', id: 'setup' },
        { type: 'message', id: 'persisted-user' },
      ],
      entriesComplete: false,
    });
    bridge.destroy();
  });

  it('falls back to the latest runtime snapshot after authority keeps changing', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-authority-exhaustion-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'authority.jsonl'),
      `${[
        { type: 'session', id: 'authority-session', cwd: '/tmp/project' },
        {
          type: 'message',
          id: 'disk-leaf',
          parentId: null,
          message: { role: 'user', content: 'Persisted transcript' },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    );
    const sessions = new SessionIndex(sessionDir);
    const originalReadEntries = sessions.readEntries.bind(sessions);
    let readCalls = 0;
    let bridge!: net.Socket;
    sessions.readEntries = async (id, before, leafId, options) => {
      const result = await originalReadEntries(id, before, leafId, options);
      if (readCalls < 3) {
        readCalls += 1;
        bridge.write(
          serializeFrame({
            kind: 'event',
            seq: readCalls + 1,
            event: {
              type: 'session.changed',
              session: {
                id: 'authority-session',
                leafId: `runtime-leaf-${readCalls}`,
                entriesComplete: true,
                entries: [
                  {
                    type: 'message',
                    id: `runtime-entry-${readCalls}`,
                    message: { role: 'user', content: 'Current runtime' },
                  },
                ],
              },
            },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return result;
    };
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      socketPath: path.join(root, 'bridge.sock'),
      sessionDir,
      sessions,
      sesh: { list: async () => [] },
    });
    await server.start();
    bridge = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: {
          type: 'runtime.hello',
          protocolVersion: 1,
          snapshot: {
            runtimeId: 'authority-runtime',
            ownership: 'external',
            pid: 123,
            cwd: '/tmp/project',
            liveState: 'working',
            session: {
              id: 'authority-session',
              entriesComplete: true,
              entries: [{ type: 'model_change', id: 'setup' }],
            },
            pendingInteractions: [],
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/authority-session`,
      { headers: { 'x-dashboard-token': 'test-token' } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      entries: [{ type: 'message', id: 'runtime-entry-3' }],
      metadata: { activeRuntimeId: 'authority-runtime' },
    });
    expect(readCalls).toBe(3);
    bridge.destroy();
  });

  it('refreshes an existing working session past its stale runtime turn', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-working-stale-turn-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'stale.jsonl'),
      `${[
        { type: 'session', id: 'stale-session', cwd: '/tmp/project' },
        {
          type: 'message',
          id: 'old-user',
          parentId: null,
          message: { role: 'user', content: 'Old request' },
        },
        {
          type: 'message',
          id: 'old-answer',
          parentId: 'old-user',
          message: { role: 'assistant', content: 'Old answer' },
        },
        {
          type: 'message',
          id: 'latest-user',
          parentId: 'old-answer',
          message: { role: 'user', content: 'Latest request' },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      socketPath: path.join(root, 'bridge.sock'),
      sessionDir,
      sesh: { list: async () => [] },
    });
    await server.start();
    const bridge = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: {
          type: 'runtime.hello',
          protocolVersion: 1,
          snapshot: {
            runtimeId: 'stale-runtime',
            ownership: 'external',
            pid: 123,
            cwd: '/tmp/project',
            liveState: 'working',
            session: {
              id: 'stale-session',
              leafId: 'old-answer',
              entriesComplete: true,
              entries: [
                { type: 'message', id: 'old-user', message: { role: 'user' } },
                {
                  type: 'message',
                  id: 'old-answer',
                  message: { role: 'assistant' },
                },
              ],
            },
            pendingInteractions: [],
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/stale-session`,
      { headers: { 'x-dashboard-token': 'test-token' } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      entries: [
        { type: 'session', id: 'stale-session' },
        { type: 'message', id: 'old-user' },
        { type: 'message', id: 'old-answer' },
        { type: 'message', id: 'latest-user' },
      ],
      entriesComplete: true,
      metadata: { activeRuntimeId: 'stale-runtime' },
    });
    bridge.destroy();
  });

  it('uses indexed history when an active runtime snapshot is complete but sparse', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-sparse-session-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'sparse-session.jsonl'),
      `${[
        { type: 'session', id: 'sparse-session', cwd: '/tmp/project' },
        {
          type: 'message',
          id: 'persisted-prompt',
          parentId: null,
          message: { role: 'user', content: 'Persisted prompt' },
        },
        {
          type: 'message',
          id: 'persisted-answer',
          parentId: 'persisted-prompt',
          message: { role: 'assistant', content: 'Persisted answer' },
        },
        {
          type: 'message',
          id: 'stale-branch-prompt',
          parentId: null,
          message: { role: 'user', content: 'Wrong branch prompt' },
        },
        {
          type: 'message',
          id: 'stale-branch-answer',
          parentId: 'stale-branch-prompt',
          message: { role: 'assistant', content: 'Wrong branch' },
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
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      socketPath: path.join(root, 'bridge.sock'),
      sessionDir,
      sesh: { list: async () => [] },
    });
    await server.start();
    const bridge = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: {
          type: 'runtime.hello',
          protocolVersion: 1,
          snapshot: {
            runtimeId: 'sparse-runtime',
            ownership: 'external',
            pid: 123,
            cwd: '/tmp/project',
            liveState: 'idle',
            session: {
              id: 'sparse-session',
              leafId: 'persisted-answer',
              entriesComplete: true,
              entries: [
                { type: 'model_change', provider: 'openai', modelId: 'gpt-5' },
                { type: 'thinking_level_change', thinkingLevel: 'medium' },
              ],
            },
            pendingInteractions: [],
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/sparse-session`,
      { headers: { 'x-dashboard-token': 'test-token' } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      entries: [
        { type: 'session', id: 'sparse-session' },
        { type: 'message', id: 'persisted-prompt' },
        { type: 'message', id: 'persisted-answer' },
      ],
      entriesComplete: true,
      metadata: { id: 'sparse-session', activeRuntimeId: 'sparse-runtime' },
    });

    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 2,
        event: {
          type: 'session.snapshot',
          session: {
            id: 'sparse-session',
            leafId: 'settings-leaf',
            entriesComplete: true,
            entries: [
              { type: 'model_change', provider: 'openai', modelId: 'gpt-5' },
              { type: 'thinking_level_change', thinkingLevel: 'medium' },
            ],
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const switched = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/sparse-session`,
      { headers: { 'x-dashboard-token': 'test-token' } },
    );
    expect(switched.status).toBe(200);
    expect(await switched.json()).toMatchObject({
      entries: [
        { type: 'session', id: 'sparse-session' },
        { type: 'model_change', id: 'settings-leaf' },
      ],
      entriesComplete: true,
      metadata: { id: 'sparse-session', activeRuntimeId: 'sparse-runtime' },
    });
    bridge.destroy();
  });

  it('captures the session cursor before a slow read, even after the replay window advances', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-session-cursor-race-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'slow.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'slow-session', cwd: '/tmp' })}\n`,
    );
    const sessions = new SessionIndex(sessionDir);
    const originalReadEntries = sessions.readEntries.bind(sessions);
    let releaseRead!: () => void;
    const readBlocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readStarted!: () => void;
    const readStartedPromise = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    sessions.readEntries = async (id) => {
      readStarted();
      await readBlocked;
      return originalReadEntries(id);
    };
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      eventBufferSize: 2,
      stateDir: path.join(root, 'state'),
      socketPath: path.join(root, 'bridge.sock'),
      sessionDir,
      sessions,
      sesh: { list: async () => [] },
    });
    await server.start();
    const cursorAtRead = server.snapshot().cursor;
    const pending = fetch(
      `http://127.0.0.1:${server.port}/api/sessions/slow-session`,
      { headers: { 'x-dashboard-token': 'test-token' } },
    );
    await readStartedPromise;
    const bridge = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: {
          type: 'runtime.hello',
          protocolVersion: 1,
          snapshot: {
            runtimeId: 'late-runtime',
            ownership: 'external',
            pid: 123,
            cwd: '/tmp',
            liveState: 'working',
            session: {
              id: 'slow-session',
              entriesComplete: false,
              entries: [],
            },
            pendingInteractions: [],
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (let index = 0; index < 4; index += 1) await server.refreshWorkspaces();
    expect(server.snapshot().cursor).toBeGreaterThan(cursorAtRead + 2);
    releaseRead();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      cursor: cursorAtRead,
      entriesComplete: false,
      metadata: { id: 'slow-session', activeRuntimeId: 'late-runtime' },
    });
    bridge.destroy();
  });

  it('forwards authenticated multipart images and removes temporary files after acknowledgement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-image-'));
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const bridge = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: {
          type: 'runtime.hello',
          protocolVersion: 1,
          snapshot: {
            runtimeId: 'image-runtime',
            ownership: 'external',
            pid: 456,
            cwd: '/tmp/project',
            liveState: 'idle',
            session: { id: 'image-session', entries: [] },
            model: {
              provider: 'test',
              model: 'vision',
              supportsImages: true,
            },
            pendingInteractions: [],
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    let buffered = '';
    let temporaryPath: string | undefined;
    const commandSeen = new Promise<void>((resolve, reject) => {
      bridge.on('data', async (chunk) => {
        buffered += chunk.toString('utf8');
        const newline = buffered.indexOf('\n');
        if (newline < 0) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const frame = parseFrame(line);
        if (frame.kind !== 'command') return;
        try {
          if (
            frame.command.type !== 'prompt' &&
            frame.command.type !== 'steer' &&
            frame.command.type !== 'followUp'
          )
            throw new Error('Expected a prompt command.');
          temporaryPath = frame.command.images?.[0]?.path;
          expect(frame.command).toMatchObject({
            type: 'prompt',
            text: 'describe this',
            images: [{ type: 'image', mediaType: 'image/png' }],
          });
          expect(temporaryPath).toBeTruthy();
          await expect(readFile(temporaryPath as string)).resolves.toBeTruthy();
          expect((await stat(temporaryPath as string)).mode & 0o777).toBe(
            0o600,
          );
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          bridge.write(
            serializeFrame({ kind: 'ack', id: frame.command.id, ok: true }),
          );
        }
      });
    });
    const form = new FormData();
    form.set(
      'command',
      JSON.stringify({ type: 'prompt', text: 'describe this' }),
    );
    form.append(
      'images',
      new Blob([
        new Uint8Array(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
          ),
        ),
      ]),
      'sample.png',
    );
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/runtimes/image-runtime/command`,
      {
        method: 'POST',
        headers: {
          Origin: `http://127.0.0.1:${server.port}`,
          'x-dashboard-token': 'test-token',
        },
        body: form,
      },
    );
    await commandSeen;
    expect(response.status).toBe(200);
    expect(temporaryPath).toBeTruthy();
    await expect(readFile(temporaryPath as string)).rejects.toThrow();
    bridge.destroy();
  });

  it('rejects spoofed image content and cleans partially written uploads', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-bad-image-'),
    );
    const stateDir = path.join(root, 'state');
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir,
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const form = new FormData();
    form.set('command', JSON.stringify({ type: 'prompt', text: 'inspect' }));
    form.append(
      'images',
      new Blob([
        new Uint8Array(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
          ),
        ),
      ]),
      'valid.png',
    );
    form.append(
      'images',
      new Blob([
        new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x62, 0x61, 0x64,
        ]),
      ]),
      'spoofed.png',
    );
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/runtimes/missing/command`,
      {
        method: 'POST',
        headers: {
          Origin: `http://127.0.0.1:${server.port}`,
          'x-dashboard-token': 'test-token',
        },
        body: form,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('PNG, JPEG, and WebP'),
    });
    expect(await readdir(path.join(stateDir, 'uploads'))).toEqual([]);
  });

  it('renames a dormant indexed session through the authenticated API', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-rename-http-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'dormant.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'dormant-id', cwd: '/tmp' })}
${JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'dormant request' } })}
`,
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir,
      sesh: { list: async () => [] },
    });
    await server.start();
    const origin = `http://127.0.0.1:${server.port}`;
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/dormant-id/name`,
      {
        method: 'POST',
        headers: {
          Origin: origin,
          'x-dashboard-token': 'test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Renamed dormant' }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      metadata: { id: 'dormant-id', name: 'Renamed dormant' },
    });
    expect(
      await readFile(path.join(sessionDir, 'dormant.jsonl'), 'utf8'),
    ).toContain('"type":"session_info"');
    expect(server.snapshot().sessions[0]).toMatchObject({
      id: 'dormant-id',
      name: 'Renamed dormant',
    });
  });

  it('coalesces and caches usage broker reads', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-usage-cache-'),
    );
    let calls = 0;
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
      usage: {
        get: async () => {
          calls += 1;
          return { calls };
        },
      },
    });
    await server.start();
    const url = `http://127.0.0.1:${server.port}/api/usage`;
    const headers = { 'x-dashboard-token': 'test-token' };
    const beforeUsage = server.snapshot();
    const [first, second] = await Promise.all([
      fetch(url, { headers }),
      fetch(url, { headers }),
    ]);
    expect(await first.json()).toEqual({ usage: { calls: 1 } });
    expect(await second.json()).toEqual({ usage: { calls: 1 } });
    expect((await (await fetch(url, { headers })).json()) as unknown).toEqual({
      usage: { calls: 1 },
    });
    expect(server.snapshot().revision).toBeGreaterThan(beforeUsage.revision);
    expect(server.snapshot().cursor).toBeGreaterThan(beforeUsage.cursor);
    expect(calls).toBe(1);
  });

  it('contains invalid or oversized provider data without poisoning live snapshots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-usage-'));
    let usageValue: unknown = { invalid: 1n };
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
      usage: { get: async () => usageValue },
    });
    await server.start();
    const headers = { 'x-dashboard-token': 'test-token' };
    const usage = await fetch(`http://127.0.0.1:${server.port}/api/usage`, {
      headers,
    });
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({ error: expect.any(String) });
    usageValue = { oversized: 'x'.repeat(300_000) };
    const oversized = await fetch(`http://127.0.0.1:${server.port}/api/usage`, {
      headers,
    });
    expect(oversized.status).toBe(200);
    expect(await oversized.json()).toMatchObject({
      error: 'Usage payload exceeds the dashboard size limit.',
    });
    const snapshot = await fetch(
      `http://127.0.0.1:${server.port}/api/snapshot`,
      { headers },
    );
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ runtimes: [] });
  });

  it('requires auth/origin, supports CORS preflight, and returns an authoritative snapshot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dashboard-http-'));
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      sesh: { list: async () => [] },
    });
    await server.start();
    const origin = `http://127.0.0.1:${server.port}`;
    const url = `http://127.0.0.1:${server.port}/api/snapshot`;
    expect((await fetch(url, { headers: { Origin: origin } })).status).toBe(
      401,
    );
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    const sameOriginResponse = await fetch(url, {
      headers: { 'x-dashboard-token': 'test-token' },
    });
    expect(sameOriginResponse.status).toBe(200);
    const response = await fetch(url, {
      headers: { Origin: origin, 'x-dashboard-token': 'test-token' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect((await response.json()) as { runtimes: unknown[] }).toMatchObject({
      runtimes: [],
      workspaces: [],
    });
  });
});
