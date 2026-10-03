import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDashboardServer } from './http.js';
import { DashboardTelemetry, parseBrowserTelemetryInput } from './telemetry.js';
import { createDashboardRouter, type DashboardTrpcContext } from './trpc.js';

const directories: string[] = [];
const collectors: DashboardTelemetry[] = [];
let server: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
function fixture(now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-telemetry-'));
  directories.push(dir);
  const telemetry = new DashboardTelemetry(join(dir, 'telemetry'), now);
  collectors.push(telemetry);
  return { dir, telemetry };
}
afterEach(async () => {
  await server?.stop();
  server = undefined;
  for (const collector of collectors.splice(0)) collector.close();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
describe('dashboard telemetry', () => {
  it('accepts only fixed browser codes and explicit notes, never arbitrary error objects or request metadata', () => {
    expect(
      parseBrowserTelemetryInput({
        code: 'render-error',
        version: 'release-1',
      }),
    ).toEqual({ code: 'render-error', version: 'release-1' });
    const invalid = [
      { code: 'render-error', version: 'v', message: 'PRIVATE' },
      { code: 'render-error', version: 'v', note: 'PRIVATE' },
      { code: 'anything', version: 'v' },
      { code: 'manual-report', version: 'v', note: ' ' },
      { code: 'manual-report', version: 'v', note: 'a'.repeat(1_001) },
      { code: 'render-error', version: 'v', sessionId: '/private/session' },
    ];
    for (const input of invalid)
      expect(() => parseBrowserTelemetryInput(input)).toThrow(
        'Invalid telemetry report.',
      );
  });
  it('bounds authenticated browser reports and resets the limit after a minute', () => {
    let now = 1_000;
    const { telemetry } = fixture(() => now);
    for (let index = 0; index < 120; index++)
      expect(
        telemetry.report({ code: 'render-error', version: 'v' }).accepted,
      ).toBe(true);
    expect(
      telemetry.report({ code: 'render-error', version: 'v' }).accepted,
    ).toBe(false);
    expect(telemetry.overview().issues[0].count).toBe(120);
    now += 60_000;
    expect(
      telemetry.report({ code: 'render-error', version: 'v' }).accepted,
    ).toBe(true);
  });
  it('records finite request successes, failures and expected rejections without input or error text', async () => {
    const { telemetry } = fixture();
    const ctx: DashboardTrpcContext = {
      serverId: () => 'server-1',
      snapshot: () => ({}) as never,
      shellSnapshot: () => ({}),
      protocolVersion: 3,
      telemetry,
      runtimeCommand: async () => {
        throw new Error('PRIVATE DATABASE DETAILS');
      },
      stopRuntime: async () => {
        throw Object.assign(new Error('PRIVATE'), { code: 'active-session' });
      },
      renameSession: async () => ({
        commandId: 'rename-1',
        status: 'completed',
        result: { sessionId: 'session-1', name: 'Safe title' },
      }),
    };
    const caller = createDashboardRouter(ctx).createCaller(ctx);
    await expect(
      caller.runtimeCommand({
        runtimeId: 'runtime-1',
        command: { id: 'command-1', type: 'prompt', text: 'PRIVATE PROMPT' },
      } as never),
    ).rejects.toThrow();
    await expect(
      caller.stopRuntime({
        runtimeId: 'runtime-1',
        commandId: 'command-2',
        force: false,
      } as never),
    ).rejects.toThrow();
    // Protocol rejection is an expected outcome, not an internal error.
    const stale = { ...ctx, protocolVersion: 2 };
    await expect(
      createDashboardRouter(stale)
        .createCaller(stale)
        .shellSnapshot({ protocolVersion: 3 }),
    ).rejects.toThrow();
    await caller.renameSession({
      sessionId: 'session-1',
      commandId: 'rename-1',
      name: 'Safe title',
    });
    const overview = telemetry.overview();
    expect(overview.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'rpc.runtimeCommand',
          outcome: 'failure',
        }),
        expect.objectContaining({
          operation: 'rpc.shellSnapshot',
          code: 'protocol-mismatch',
          outcome: 'expected',
        }),
        expect.objectContaining({
          operation: 'rpc.stopRuntime',
          code: 'active-session',
          outcome: 'expected',
        }),
      ]),
    );
    expect(JSON.stringify(overview)).not.toContain('PRIVATE');
    const before = overview.eventCount;
    await caller.telemetryOverview();
    await caller.telemetryReport({
      code: 'manual-report',
      version: 'v',
      note: 'Stale UI',
    });
    expect(telemetry.overview().eventCount).toBe(before + 1);
  });
  it('requires authentication and a permitted origin for reads and reports on an isolated daemon', async () => {
    const { dir } = fixture();
    server = await createDashboardServer({
      port: 0,
      authToken: 'telemetry-test-token',
      origins: ['http://dashboard.test'],
      stateDir: join(dir, 'state'),
      sessionDir: join(dir, 'sessions'),
      telemetryDir: join(dir, 'telemetry'),
    });
    await server.start();
    const url = `http://127.0.0.1:${server.port}/trpc/telemetryReport`;
    const body = JSON.stringify({
      code: 'manual-report',
      version: 'v',
      note: 'Stale widget token=secret123',
    });
    const headers = {
      origin: 'http://dashboard.test',
      'content-type': 'application/json',
      'x-dashboard-protocol-version': '3',
    };
    expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(
      401,
    );
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: {
            ...headers,
            origin: 'http://evil.test',
            'x-dashboard-token': 'telemetry-test-token',
          },
          body,
        })
      ).status,
    ).toBe(403);
    const authorized = {
      ...headers,
      'x-dashboard-token': 'telemetry-test-token',
    };
    expect(
      (await fetch(url, { method: 'POST', headers: authorized, body })).status,
    ).toBe(200);
    const staleSubscription = await fetch(
      `http://127.0.0.1:${server.port}/trpc/shellSubscribe?input=%7B%7D`,
      { headers: { ...authorized, 'x-dashboard-protocol-version': '2' } },
    );
    expect(staleSubscription.status).toBe(200);
    expect(await staleSubscription.text()).toContain('protocol-mismatch');
    const read = await fetch(
      `http://127.0.0.1:${server.port}/trpc/telemetryOverview`,
      { method: 'POST', headers: authorized, body: 'null' },
    );
    expect(read.status).toBe(200);
    const data = (await read.json()) as {
      result: {
        data: {
          issues: {
            code: string;
            outcome: string;
            samples: { note?: string }[];
          }[];
        };
      };
    };
    const issues = data.result.data.issues;
    expect(
      issues.find((issue) => issue.outcome === 'quirk')?.samples[0].note,
    ).toContain('[redacted]');
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'protocol-mismatch',
        outcome: 'expected',
      }),
    );
    expect(JSON.stringify(data)).not.toContain('secret123');
  });
});
