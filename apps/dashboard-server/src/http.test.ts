import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseFrame, serializeFrame } from '@pi-dashboard/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createDashboardServer } from './http.js';
import type { ShellFeed } from './live-feeds.js';
import { MetadataStore } from './metadata.js';
import { RuntimeRegistry } from './runtime-registry.js';
import { SessionIndex } from './session-index.js';

let server: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('dashboard HTTP boundary', () => {
  it('publishes exact durable links for indexed sessions before HTTP is ready', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-session-links-'));
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'ordinary.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'ordinary-session', cwd: '/tmp' })}\n`,
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
    const response = await fetch(`${origin}/api/session-threads`, {
      headers: {
        Origin: origin,
        'x-dashboard-token': 'test-token',
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        sessionId: 'ordinary-session',
        threadId: expect.stringMatching(/^thread-session-/),
      },
    ]);
  });

  it('publishes auxiliary JSONL appends as ordered normalized session events', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-aux-live-'));
    const sessionDir = path.join(root, 'sessions');
    const delegateDir = path.join(root, '.delegate-sessions');
    await mkdir(sessionDir, { recursive: true });
    await mkdir(delegateDir, { recursive: true });
    const file = path.join(delegateDir, 'child.jsonl');
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', id: 'live-child', cwd: '/tmp' })}\n`,
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir,
      delegateSessionDir: delegateDir,
      sesh: { list: async () => [] },
    });
    await server.start();
    const internals = server as unknown as {
      sessions: { close(): void };
      sessionFeeds: {
        get(id: string): {
          subscribe(options: {
            lastEventId?: string;
            buildSnapshot: (sequence: number) => Promise<unknown>;
          }): AsyncGenerator<unknown>;
        };
      };
      buildSessionSnapshot(
        id: string,
        before: string | undefined,
        sequence: number,
      ): Promise<unknown>;
    };
    // This boundary test drives publication explicitly. The SessionIndex suite
    // covers real watcher ordering; disable it here to avoid racing two sources.
    internals.sessions.close();
    const feed = internals.sessionFeeds.get('live-child');
    const stream = feed.subscribe({
      buildSnapshot: (sequence) =>
        internals.buildSessionSnapshot('live-child', undefined, sequence),
    });
    expect((await stream.next()).value).toMatchObject({ kind: 'snapshot' });
    expect((await stream.next()).value).toMatchObject({ kind: 'caught-up' });
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', id: 'live-child', cwd: '/tmp' })}\n${JSON.stringify(
        {
          type: 'message',
          id: 'live-message',
          message: { role: 'assistant', content: 'from append' },
        },
      )}\n`,
    );
    server.publishSessionIndexChange('live-child', true);
    const event = await Promise.race([
      stream.next(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('append event timed out')), 2_000),
      ),
    ]);
    expect(event.value).toMatchObject({
      kind: 'event',
      event: {
        type: 'session-event',
        event: {
          type: 'message.finished',
          message: { messageId: 'live-message', role: 'assistant' },
        },
      },
    });
    const priorEventId = (event.value as { id: string }).id;
    await stream.return(undefined);

    // The idle feed is invalidated before this append, so reconnecting with
    // the old Last-Event-ID must take the authoritative snapshot path.
    await writeFile(
      file,
      `${[
        { type: 'session', id: 'live-child', cwd: '/tmp' },
        {
          type: 'message',
          id: 'live-message',
          message: { role: 'assistant', content: 'from append' },
        },
        {
          type: 'message',
          id: 'disconnected-message',
          message: { role: 'assistant', content: 'while disconnected' },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    );
    server.publishSessionIndexChange('live-child', true);
    const resumedFeed = internals.sessionFeeds.get('live-child');
    const resumed = resumedFeed.subscribe({
      lastEventId: priorEventId,
      buildSnapshot: (sequence) =>
        internals.buildSessionSnapshot('live-child', undefined, sequence),
    });
    const resumedSnapshot = await resumed.next();
    expect(resumedSnapshot.value).toMatchObject({ kind: 'snapshot' });
    expect(
      (resumedSnapshot.value as { snapshot: { entries: unknown[] } }).snapshot
        .entries,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'disconnected-message' }),
      ]),
    );
    expect((await resumed.next()).value).toMatchObject({ kind: 'caught-up' });

    await writeFile(
      file,
      `${[
        { type: 'session', id: 'live-child', cwd: '/tmp' },
        {
          type: 'message',
          id: 'live-message',
          message: { role: 'assistant', content: 'from append' },
        },
        {
          type: 'message',
          id: 'disconnected-message',
          message: { role: 'assistant', content: 'while disconnected' },
        },
        {
          type: 'message',
          id: 'later-message',
          message: { role: 'assistant', content: 'after rebase' },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    );
    server.publishSessionIndexChange('live-child', true);
    await expect(
      Promise.race([
        resumed.next(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('post-rebase event timed out')),
            2_000,
          ),
        ),
      ]),
    ).resolves.toMatchObject({
      value: {
        kind: 'event',
        event: {
          event: {
            type: 'message.finished',
            message: { messageId: 'later-message' },
          },
        },
      },
    });
    await resumed.return(undefined);
  });

  it('carries a contiguous trailing marker suffix across bounded ranges', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-aux-markers-'));
    const sessionDir = path.join(root, 'sessions');
    const delegateDir = path.join(root, '.delegate-sessions');
    await mkdir(sessionDir, { recursive: true });
    await mkdir(delegateDir, { recursive: true });
    const file = path.join(delegateDir, 'child.jsonl');
    const header = { type: 'session', id: 'marker-child', cwd: '/tmp' };
    await writeFile(file, `${JSON.stringify(header)}\n`);
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir,
      delegateSessionDir: delegateDir,
      sesh: { list: async () => [] },
    });
    await server.start();
    const internals = server as unknown as {
      sessions: { close(): void };
      sessionFeeds: {
        get(id: string): {
          subscribe(options: {
            buildSnapshot: (sequence: number) => Promise<unknown>;
          }): AsyncGenerator<unknown>;
        };
      };
      buildSessionSnapshot(
        id: string,
        before: string | undefined,
        sequence: number,
      ): Promise<unknown>;
    };
    internals.sessions.close();
    const stream = internals.sessionFeeds.get('marker-child').subscribe({
      buildSnapshot: (sequence) =>
        internals.buildSessionSnapshot('marker-child', undefined, sequence),
    });
    await stream.next();
    await stream.next();
    const markerOne = {
      type: 'custom',
      customType: 'steering-message',
      data: { timestamp: 1001, text: 'first steer' },
    };
    const markerTwo = {
      type: 'custom',
      customType: 'steering-message',
      data: { timestamp: 1002, text: 'second steer' },
    };
    const records = [
      ...Array.from({ length: 254 }, (_, index) => ({
        type: 'custom',
        customType: 'steering-message',
        data: { timestamp: 2000 + index, text: `prefix steer ${index}` },
      })),
      markerOne,
      markerTwo,
      {
        type: 'message',
        id: 'steered-one',
        message: { role: 'user', content: 'first steer', timestamp: 1001 },
      },
      {
        type: 'message',
        id: 'steered-two',
        message: { role: 'user', content: 'second steer', timestamp: 1002 },
      },
    ];
    await writeFile(
      file,
      `${[header, ...records].map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    server.publishSessionIndexChange('marker-child', true);
    const seen = new Map<string, unknown>();
    await Promise.race([
      (async () => {
        while (!seen.has('steered-one') || !seen.has('steered-two')) {
          const item = await stream.next();
          if (item.done) throw new Error('marker feed closed');
          const event = item.value as {
            kind?: string;
            event?: {
              event?: { type?: string; message?: { messageId?: string } };
            };
          };
          const message = event.event?.event?.message;
          if (event.kind === 'event' && message?.messageId)
            seen.set(message.messageId, event.event?.event);
        }
      })(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('marker suffix timed out')), 3_000),
      ),
    ]);
    expect(seen.get('steered-one')).toMatchObject({
      type: 'message.finished',
      message: { data: { deliveryMode: 'steer' } },
    });
    expect(seen.get('steered-two')).toMatchObject({
      type: 'message.finished',
      message: { data: { deliveryMode: 'steer' } },
    });
    await stream.return(undefined);
  });

  it('loads delegate history summaries without details and fetches one selected run lazily', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-delegate-history-lazy-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    const sessionEntries = [
      { type: 'session', id: 'lazy-session', cwd: '/tmp' },
      {
        type: 'message',
        id: 'delegate-result-1',
        parentId: null,
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            runs: [
              {
                runId: 'run-1',
                lineageId: 'lineage-1',
                name: 'Lazy worker',
                task: 'inspect the source '.repeat(20_000),
                state: 'success',
                rawPayload: 'not retained in summary or detail'.repeat(20_000),
                messages: [
                  {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'selected response' }],
                  },
                ],
                activities: [
                  {
                    type: 'tool',
                    label: 'large activity',
                    transcriptText:
                      'distinctive large activity payload '.repeat(10_000),
                  },
                ],
              },
            ],
          },
        },
      },
    ];
    expect(JSON.stringify(sessionEntries[1]).length).toBeGreaterThan(
      512 * 1024,
    );
    await writeFile(
      path.join(sessionDir, 'lazy-session.jsonl'),
      `${sessionEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      socketPath: path.join(
        os.tmpdir(),
        `dh-${path.basename(root).slice(-6)}.sock`,
      ),
      sessionDir,
      sesh: { list: async () => [] },
    });
    await server.start();
    const headers = { 'x-dashboard-token': 'test-token' };
    const summaryResponse = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/lazy-session/delegate-history`,
      { headers },
    );
    expect(summaryResponse.status).toBe(200);
    const summary = (await summaryResponse.json()) as Record<string, unknown>;
    expect(JSON.stringify(summary)).not.toContain(
      'distinctive large activity payload',
    );
    expect(JSON.stringify(summary)).not.toContain(
      'not retained in summary or detail',
    );
    expect(summary).not.toHaveProperty('details');
    const group = (summary.groups as Array<Record<string, unknown>>)[0];
    const run = (group?.runs as Array<Record<string, unknown>>)[0];
    expect(run).not.toHaveProperty('details');
    const detailResponse = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/lazy-session/delegate-history/runs/run-1?lineageId=lineage-1&leafId=delegate-result-1`,
      { headers },
    );
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as Record<string, unknown>;
    expect(detail.run).toMatchObject({
      runId: 'run-1',
      details: {
        response: 'selected response',
        activities: [
          {
            text: expect.stringContaining('distinctive large activity payload'),
          },
        ],
        truncated: true,
      },
    });
    const details = (detail.run as Record<string, unknown>).details as Record<
      string,
      unknown
    >;
    expect((details.task as string).length).toBeLessThanOrEqual(20_000);
    expect(
      (
        (details.activities as Array<Record<string, unknown>>)[0]
          ?.text as string
      ).length,
    ).toBeLessThanOrEqual(8_000);
    expect(JSON.stringify(detail)).not.toContain(
      'not retained in summary or detail',
    );
  });

  it('canonicalizes explicit duplicate background runs for summary and detail', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-delegate-history-duplicate-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    const run = {
      runId: 'run-modern',
      lineageId: 'lineage-modern',
      backgroundJobId: 'job-modern',
      name: 'Modern worker',
      task: 'inspect the source',
      state: 'success',
      exitCode: 0,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'terminal response' }],
        },
      ],
      activities: [
        {
          type: 'tool',
          label: 'terminal activity',
          transcriptText: 'terminal activity output',
          status: 'completed',
        },
      ],
    };
    const entries = [
      { type: 'session', id: 'duplicate-session', cwd: '/tmp' },
      {
        type: 'message',
        id: 'launch-1',
        message: {
          role: 'toolResult',
          toolName: 'delegate',
          details: {
            runs: [
              {
                ...run,
                state: 'queued',
                messages: [],
                activities: [],
              },
            ],
          },
        },
      },
      {
        type: 'custom_message',
        id: 'completion-1',
        message: {
          customType: 'delegate-job-result',
          details: {
            jobs: [{ id: 'job-modern', state: 'success', runs: [run] }],
          },
        },
      },
    ];
    await writeFile(
      path.join(sessionDir, 'duplicate-session.jsonl'),
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      socketPath: path.join(
        os.tmpdir(),
        `dh-${path.basename(root).slice(-6)}.sock`,
      ),
      sessionDir,
      sesh: { list: async () => [] },
    });
    await server.start();
    const headers = { 'x-dashboard-token': 'test-token' };
    const origin = `http://127.0.0.1:${server.port}`;
    const summaryResponse = await fetch(
      `${origin}/api/sessions/duplicate-session/delegate-history`,
      { headers },
    );
    expect(summaryResponse.status).toBe(200);
    const summary = (await summaryResponse.json()) as {
      groups: Array<{ runs: Array<{ runId: string; state: string }> }>;
    };
    expect(summary.groups[0]?.runs).toEqual([
      expect.objectContaining({ runId: 'run-modern', state: 'success' }),
    ]);
    const detailResponse = await fetch(
      `${origin}/api/sessions/duplicate-session/delegate-history/runs/run-modern?lineageId=lineage-modern&leafId=completion-1`,
      { headers },
    );
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as Record<string, unknown>;
    expect(detail.run).toMatchObject({
      state: 'success',
      details: {
        response: 'terminal response',
        activities: [{ text: 'terminal activity output' }],
      },
    });
  });

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
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    for (const id of ['startup-session-one', 'startup-session-two'])
      await writeFile(
        path.join(sessionDir, `${id}.jsonl`),
        `${JSON.stringify({ type: 'session', id, cwd: '/tmp/project' })}\n`,
      );
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
    const http = (server as unknown as { http: { listening: boolean } }).http;
    expect(http.listening).toBe(false);
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
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.snapshot().revision).toBe(0);
    expect(server.snapshot().cursor).toBe(0);
    releaseWorkspaces();
    await startup;
    expect(http.listening).toBe(true);
    const input = encodeURIComponent(JSON.stringify({ protocolVersion: 3 }));
    const response = await fetch(
      `http://127.0.0.1:${server.port}/trpc/shellSnapshot?input=${input}`,
      {
        headers: {
          authorization: 'Bearer test-token',
          'x-dashboard-protocol-version': '3',
        },
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: {
        data?: { snapshot?: { sessions?: Array<{ id: string }> } };
      };
    };
    expect(body.result?.data?.snapshot?.sessions?.map(({ id }) => id)).toEqual([
      'startup-session-two',
      'startup-session-one',
    ]);
    expect(server.snapshot().revision).toBe(1);
    expect(server.snapshot().cursor).toBe(1);
    bridge.destroy();
  });

  it('publishes session metadata before a replacement runtime upsert', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-session-ordering-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    const startedAt = Date.parse('2026-08-15T12:00:00.000Z');
    await writeFile(
      path.join(sessionDir, 'replacement-session.jsonl'),
      `${JSON.stringify({
        type: 'session',
        id: 'replacement-session',
        timestamp: new Date(startedAt).toISOString(),
        cwd: '/tmp/project',
      })}\n${JSON.stringify({
        type: 'session_info',
        id: 'session-info-1',
        name: 'Replacement session',
      })}\n`,
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir,
      sesh: { list: async () => [] },
    });
    await server.start();
    const runningServer = server;
    const shellFeed = (runningServer as unknown as { shellFeed: ShellFeed })
      .shellFeed;
    const shellStream = shellFeed.subscribe({
      buildSnapshot: (sequence) => ({
        snapshot: runningServer.snapshot() as never,
        cursor: sequence,
      }),
    });
    await shellStream.next();
    await shellStream.next();
    const bridge = net.createConnection(runningServer.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    try {
      bridge.write(
        serializeFrame({
          kind: 'event',
          seq: 1,
          event: {
            type: 'runtime.hello',
            protocolVersion: 1,
            snapshot: {
              runtimeId: 'replacement-runtime',
              ownership: 'external',
              pid: 1,
              cwd: '/tmp/project',
              liveState: 'idle',
              session: { id: 'replacement-session', entries: [] },
            },
          },
        }),
      );
      const metadataEvent = await shellStream.next();
      const runtimeEvent = await shellStream.next();
      expect(metadataEvent.value).toMatchObject({
        kind: 'event',
        event: {
          domain: 'session-index',
          data: {
            kind: 'delta',
            upsert: [
              expect.objectContaining({
                id: 'replacement-session',
                name: 'Replacement session',
                startedAt,
              }),
            ],
          },
        },
      });
      const runtimeShellEvent = (
        runtimeEvent.value as {
          event: {
            domain: string;
            data: {
              kind: string;
              runtime?: { runtimeId?: string; session?: { id?: string } };
            };
          };
        }
      ).event;
      expect(runtimeShellEvent.domain).toBe('runtime');
      expect(runtimeShellEvent.data.kind).toBe('upsert');
      expect(runtimeShellEvent.data.runtime).toMatchObject({
        runtimeId: 'replacement-runtime',
        session: { id: 'replacement-session' },
      });
    } finally {
      await shellStream.return(undefined);
      bridge.destroy();
    }
  });

  it('does not publish shell refreshes for managed transcript activity', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-transcript-shell-feed-'),
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      socketPath: path.join(
        os.tmpdir(),
        `pd-${path.basename(root).slice(-8)}-transcript.sock`,
      ),
      sesh: { list: async () => [] },
    });
    await server.start();
    const bridge = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    const runtime = {
      runtimeId: 'managed-transcript-runtime',
      ownership: 'external',
      pid: 1,
      cwd: '/tmp/project',
      liveState: 'idle',
      session: { id: 'managed-transcript-session', entries: [] },
    };
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: {
          type: 'runtime.hello',
          protocolVersion: 1,
          snapshot: runtime,
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const afterHello = server.snapshot().cursor;
    expect(afterHello).toBeGreaterThan(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const beforeHeartbeat = server
      .snapshot()
      .runtimes.find(
        (item) => item.runtimeId === runtime.runtimeId,
      )?.lastSeenAt;
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 2,
        event: { type: 'runtime.heartbeat', state: 'idle' },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const afterHeartbeat = server.snapshot();
    expect(afterHeartbeat.cursor).toBeGreaterThan(afterHello);
    const heartbeatLastSeenAt = afterHeartbeat.runtimes.find(
      (item) => item.runtimeId === runtime.runtimeId,
    )?.lastSeenAt;
    expect(heartbeatLastSeenAt).toBeDefined();
    expect(heartbeatLastSeenAt).toBeGreaterThan(beforeHeartbeat ?? 0);
    for (const [seq, type] of [
      [3, 'message.updated'],
      [4, 'message.finished'],
      [5, 'tool.updated'],
      [6, 'tool.finished'],
    ] as const) {
      bridge.write(
        serializeFrame({
          kind: 'event',
          seq,
          event: {
            type,
            sessionId: 'managed-transcript-session',
            ...(type.startsWith('message')
              ? {
                  message: {
                    messageId: `assistant-stream-${seq}`,
                    role: 'assistant',
                    content: `transcript ${seq}`,
                    phase: 'updated',
                  },
                }
              : {
                  tool: {
                    toolCallId: `tool-${seq}`,
                    name: 'shell',
                    phase: 'updated',
                  },
                }),
          },
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    // Heartbeat recency is published once; transcript activity does not
    // alternate the runtime signature back to a shape without lastSeenAt.
    expect(server.snapshot().cursor).toBe(afterHeartbeat.cursor);
    bridge.destroy();
  });

  it('publishes a shell removal when stop forgets a runtime without goodbye', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-runtime-stop-shell-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'stop-shell-session.jsonl'),
      `${JSON.stringify({
        type: 'session',
        version: 4,
        id: 'stop-shell-session',
        timestamp: new Date().toISOString(),
        cwd: '/tmp/project',
      })}\n`,
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir,
      socketPath: path.join(
        os.tmpdir(),
        `pd-${path.basename(root).slice(-8)}-stop.sock`,
      ),
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
            runtimeId: 'stop-shell-runtime',
            ownership: 'external',
            pid: 1,
            cwd: '/tmp/project',
            liveState: 'idle',
            session: { id: 'stop-shell-session', entries: [] },
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const before = server.snapshot();
    expect(before.runtimes).toHaveLength(1);
    expect(
      before.sessions.find((item) => item.id === 'stop-shell-session'),
    ).toMatchObject({ activeRuntimeId: 'stop-shell-runtime' });

    // RuntimeManager.stop() ends every successful stop path with forget().
    // Exercise that authoritative transition directly so this test isolates
    // shell publication from command acknowledgement timing.
    server.registry.forget('stop-shell-runtime');
    const after = server.snapshot();
    expect(after.runtimes).toHaveLength(0);
    expect(
      after.sessions.find((item) => item.id === 'stop-shell-session')
        ?.activeRuntimeId,
    ).toBeUndefined();
    // One runtime removal plus one session-index upsert clearing
    // activeRuntimeId must reach the shell feed.
    expect(after.cursor - before.cursor).toBe(2);
    bridge.destroy();
  });

  it('keeps a shared session feed active when one sibling runtime is removed', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-runtime-sibling-stop-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'shared-session.jsonl'),
      `${JSON.stringify({
        type: 'session',
        version: 4,
        id: 'shared-session',
        timestamp: new Date().toISOString(),
        cwd: '/tmp/project',
      })}\n`,
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir,
      socketPath: path.join(
        os.tmpdir(),
        `pd-${path.basename(root).slice(-8)}-sibling.sock`,
      ),
      sesh: { list: async () => [] },
    });
    await server.start();
    const bridges = [
      net.createConnection(server.socketPath),
      net.createConnection(server.socketPath),
    ];
    await Promise.all(
      bridges.map(
        (bridge) =>
          new Promise<void>((resolve, reject) => {
            bridge.once('connect', resolve);
            bridge.once('error', reject);
          }),
      ),
    );
    for (const [index, bridge] of bridges.entries())
      bridge.write(
        serializeFrame({
          kind: 'event',
          seq: 1,
          event: {
            type: 'runtime.hello',
            protocolVersion: 1,
            snapshot: {
              runtimeId: `shared-runtime-${index + 1}`,
              ownership: 'external',
              pid: index + 1,
              cwd: '/tmp/project',
              liveState: 'idle',
              session: { id: 'shared-session', entries: [] },
            },
          },
        }),
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const before = server.snapshot();
    expect(before.runtimes).toHaveLength(2);
    expect(
      before.sessions.find((item) => item.id === 'shared-session'),
    ).toMatchObject({ activeRuntimeId: 'shared-runtime-2' });

    server.registry.forget('shared-runtime-1');
    const after = server.snapshot();
    expect(after.runtimes.map((runtime) => runtime.runtimeId)).toEqual([
      'shared-runtime-2',
    ]);
    expect(
      after.sessions.find((item) => item.id === 'shared-session'),
    ).toMatchObject({ activeRuntimeId: 'shared-runtime-2' });
    expect(
      (
        server as unknown as {
          sessionFeeds: { get: (sessionId: string) => { active: boolean } };
        }
      ).sessionFeeds.get('shared-session').active,
    ).toBe(true);
    expect(after.cursor - before.cursor).toBe(1);
    for (const bridge of bridges) bridge.destroy();
  });

  it('marks a retained offline runtime feed inactive', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-runtime-offline-feed-'),
    );
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'offline-session.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'offline-session', cwd: '/tmp' })}\n`,
    );
    const registry = new RuntimeRegistry({
      allowExternalWithoutToken: true,
      disconnectGraceMs: 0,
      onChange: (change) =>
        (
          server as unknown as
            | { handleRegistryChange(value: unknown): void }
            | undefined
        )?.handleRegistryChange(change),
    });
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir,
      socketPath: path.join(
        os.tmpdir(),
        `pd-${path.basename(root).slice(-8)}-offline.sock`,
      ),
      sesh: { list: async () => [] },
      registry,
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
            runtimeId: 'offline-runtime',
            ownership: 'external',
            pid: 1,
            cwd: '/tmp',
            liveState: 'idle',
            session: { id: 'offline-session', entries: [] },
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const feeds = (
      server as unknown as {
        sessionFeeds: { get: (id: string) => { active: boolean } };
      }
    ).sessionFeeds;
    expect(feeds.get('offline-session').active).toBe(true);
    bridge.destroy();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(feeds.get('offline-session').active).toBe(false);
  });

  it('re-emits an identical runtime after goodbye removal', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-runtime-readd-'),
    );
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      socketPath: path.join(
        os.tmpdir(),
        `pd-${path.basename(root).slice(-8)}-readd.sock`,
      ),
      sesh: { list: async () => [] },
    });
    await server.start();
    const bridge = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      bridge.once('connect', resolve);
      bridge.once('error', reject);
    });
    const runtime = {
      runtimeId: 'readd-runtime',
      ownership: 'external' as const,
      pid: 1,
      cwd: '/tmp/project',
      liveState: 'idle' as const,
      session: { id: 'readd-session', entries: [] },
    };
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: { type: 'runtime.hello', protocolVersion: 1, snapshot: runtime },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 2,
        event: { type: 'runtime.goodbye', reason: 'reload' },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const removed = server.snapshot();
    expect(removed.runtimes).toHaveLength(0);
    bridge.destroy();
    const replacement = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      replacement.once('connect', resolve);
      replacement.once('error', reject);
    });
    replacement.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: { type: 'runtime.hello', protocolVersion: 1, snapshot: runtime },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const readded = server.snapshot();
    expect(readded.cursor).toBeGreaterThan(removed.cursor);
    expect(readded.runtimes).toHaveLength(1);
    expect(readded.runtimes[0]?.runtimeId).toBe(runtime.runtimeId);
    replacement.destroy();
  });

  it('rejects an authoritative session index that exceeds frame capacity', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-session-replacement-'),
    );
    // Count alone is not the capacity policy: 4,096 authoritative entries
    // with large metadata must fail rather than be silently truncated.
    const sessions = Array.from({ length: 4_096 }, (_, index) => ({
      id: `session-${index}`,
      file: '',
      cwd: '/tmp',
      title: 'x'.repeat(600),
      updatedAt: index,
    }));
    const sessionIndex = {
      start: async () => undefined,
      close: () => undefined,
      list: () => sessions,
      get: (id: string) => sessions.find((session) => session.id === id),
    } as unknown as SessionIndex;
    server = await createDashboardServer({
      port: 0,
      authToken: 'test-token',
      stateDir: path.join(root, 'state'),
      sessionDir: path.join(root, 'sessions'),
      socketPath: path.join(
        os.tmpdir(),
        `pd-${path.basename(root).slice(-8)}-index.sock`,
      ),
      sessions: sessionIndex,
      sesh: { list: async () => [] },
    });
    await server.start();
    const input = encodeURIComponent(JSON.stringify({ protocolVersion: 3 }));
    const response = await fetch(
      `http://127.0.0.1:${server.port}/trpc/shellSnapshot?input=${input}`,
      {
        headers: {
          authorization: 'Bearer test-token',
          'x-dashboard-protocol-version': '3',
        },
      },
    );
    expect(response.status).toBe(500);
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
    expect(snapshot.status).toBe(404);
  });
});
