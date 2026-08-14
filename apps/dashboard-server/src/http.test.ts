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
import { MetadataStore } from './metadata.js';
import { SessionIndex } from './session-index.js';

let server: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('dashboard HTTP boundary', () => {
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
    expect(snapshot.status).toBe(404);
  });
});
