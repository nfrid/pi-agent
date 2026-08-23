import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildDelegateChildEnvironment,
  checkpointLeadMs,
  effectiveDelegateHome,
  MAX_STDERR_BYTES,
  runHostedDelegateChild,
  spawnDelegateChild,
} from './delegate-child';
import { createRun } from './types';

function systemHomeWithoutEnvironment(): string {
  const configured = process.env.HOME;
  const hadHome = Object.hasOwn(process.env, 'HOME');
  if (hadHome) delete process.env.HOME;
  try {
    return homedir();
  } finally {
    if (hadHome) process.env.HOME = configured;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const hostedJobId = '123e4567-e89b-42d3-a456-426614174000';

type HostedCase = {
  eventResponse?: {
    events: Array<{
      offset: number;
      stream: 'stdout' | 'stderr';
      text: string;
      truncated: boolean;
    }>;
    truncated: boolean;
    complete: boolean;
    nextOffset: number;
  };
  status: 'running' | 'done' | 'failed' | 'killed';
  startStatus?: 'running' | 'done' | 'failed' | 'killed';
  exitCode?: number;
  timedOut?: boolean;
  error?: string;
  exactEnvCapability?: boolean;
  infoResponse?: 'unknown' | 'missing';
  unknownJob?: boolean;
  delayStopMs?: number;
  delayInspectMs?: number;
  onRequest?: (operation: string) => void;
};

type HostedStartInput = {
  command?: string;
  argv?: string[];
  exactEnv?: boolean;
};

async function withHostedCase<T>(
  setup: HostedCase,
  work: (
    calls: string[],
    startInput: () => HostedStartInput | undefined,
  ) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), 'delegate-hosted-test-'));
  const socketPath = path.join(root, 'process-host.sock');
  const calls: string[] = [];
  let startInput: HostedStartInput | undefined;
  let stopped = false;
  const snapshot = (status = setup.status) => ({
    id: hostedJobId,
    ownerSession: 'parent-session',
    title: 'Delegate: Review',
    command: 'pi',
    cwd: process.cwd(),
    status,
    createdAt: 1,
    ...(setup.exitCode === undefined ? {} : { exitCode: setup.exitCode }),
    ...(setup.timedOut === undefined ? {} : { timedOut: setup.timedOut }),
    ...(setup.error === undefined ? {} : { error: setup.error }),
    stdout: { text: '', totalBytes: 0, droppedBytes: 0 },
    stderr: { text: '', totalBytes: 0, droppedBytes: 0 },
  });
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        op: string;
        input?: HostedStartInput;
      };
      calls.push(request.op);
      setup.onRequest?.(request.op);
      if (request.op === 'start') startInput = request.input;
      if (request.op === 'stop') stopped = true;
      const response =
        request.op === 'info'
          ? setup.infoResponse === 'unknown'
            ? { v: 1, ok: false, error: 'Unknown background-jobs operation.' }
            : {
                v: 1,
                ok: true,
                ...(setup.infoResponse === 'missing'
                  ? {}
                  : {
                      capabilities: {
                        exactEnv: setup.exactEnvCapability ?? true,
                      },
                    }),
              }
          : request.op === 'start'
            ? {
                v: 1,
                ok: true,
                job: snapshot(setup.startStatus ?? setup.status),
              }
            : request.op === 'events'
              ? {
                  v: 1,
                  ok: true,
                  events: stopped
                    ? {
                        events: [],
                        truncated: false,
                        complete: true,
                        nextOffset: 0,
                      }
                    : (setup.eventResponse ?? {
                        events: [],
                        truncated: false,
                        complete: setup.status !== 'running',
                        nextOffset: 0,
                      }),
                }
              : request.op === 'stop' || request.op === 'wait'
                ? {
                    v: 1,
                    ok: true,
                    job: snapshot(stopped ? 'killed' : setup.status),
                  }
                : request.op === 'inspect'
                  ? setup.unknownJob
                    ? { v: 1, ok: true }
                    : {
                        v: 1,
                        ok: true,
                        job: snapshot(stopped ? 'killed' : setup.status),
                      }
                  : { v: 1, ok: true };
      const delayMs =
        request.op === 'stop'
          ? (setup.delayStopMs ?? 0)
          : request.op === 'inspect'
            ? (setup.delayInspectMs ?? 0)
            : 0;
      if (delayMs > 0)
        setTimeout(() => socket.end(`${JSON.stringify(response)}\n`), delayMs);
      else socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  vi.stubEnv('PI_PROCESS_HOST_SOCKET', socketPath);
  try {
    return await work(calls, () => startInput);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

describe('delegate child environment', () => {
  test('scales the checkpoint window without moving the hard deadline', () => {
    expect(checkpointLeadMs(10_000)).toBe(2_000);
    expect(checkpointLeadMs(10 * 60_000)).toBe(30_000);
    expect(checkpointLeadMs(0)).toBe(0);
  });

  test('forwards a set parent HOME and keeps the existing allowlist bounded', () => {
    vi.stubEnv('HOME', '/tmp/parent-home');
    vi.stubEnv('DELEGATE_SECRET', 'must-not-forward');
    const environment = buildDelegateChildEnvironment({
      HOME: '/tmp/worktree-home',
      PI_DELEGATE_WORKTREE: 'worktree-id',
    });

    expect(environment).toMatchObject({
      HOME: '/tmp/parent-home',
      PI_DELEGATE_CHILD: '1',
      PI_DELEGATE_WORKTREE: 'worktree-id',
    });
    expect(environment.DELEGATE_SECRET).toBeUndefined();
  });

  test.each([
    'absent',
    'empty',
  ])('uses node homedir fallback when parent HOME is %s', (mode) => {
    if (mode === 'absent') vi.stubEnv('HOME', undefined);
    else vi.stubEnv('HOME', '');
    const fallback = systemHomeWithoutEnvironment();

    expect(effectiveDelegateHome()).toBe(fallback);
    expect(buildDelegateChildEnvironment({}).HOME).toBe(fallback);
  });

  test('requests a checkpoint before hard timeout and still terminates an idle child', async () => {
    const checkpoint = vi.fn();
    const run = createRun('checkpoint');
    const result = await spawnDelegateChild(run, {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1_000)'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 250,
      checkpointLeadMs: 100,
      killGraceMs: 100,
      onCheckpoint: checkpoint,
      onLine: vi.fn(),
    });

    expect(checkpoint).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ timedOut: true, exitCode: 124 });
  });

  test('parses JSON-mode control acknowledgements from stderr', async () => {
    const acknowledge = vi.fn();
    const run = createRun('stderr acknowledgement');
    const control = JSON.stringify({
      type: 'delegate_control_ack',
      controlId: 'pause-1',
      controlKind: 'pause',
      controlGeneration: 7,
    });
    const script = `process.stderr.write(${JSON.stringify(`${control}\nnormal diagnostic\n`)});`;

    const result = await spawnDelegateChild(run, {
      command: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5_000,
      onControlAck: acknowledge,
      onLine: vi.fn(),
    });

    expect(result.exitCode).toBe(0);
    expect(acknowledge).toHaveBeenCalledWith('pause-1', 'pause', 7);
    expect(run.stderr).toBe('normal diagnostic\n');
    expect(run.stderr).not.toContain('delegate_control_ack');
  });

  test('projects stderr checkpoint acknowledgements and bounds diagnostics', async () => {
    const acknowledge = vi.fn();
    const update = vi.fn();
    const run = createRun('stderr checkpoint');
    run.checkpoint = { requestedAt: 1, state: 'requested' };
    const checkpoint = JSON.stringify({
      type: 'delegate_control_ack',
      controlId: 'checkpoint-1',
      controlKind: 'checkpoint',
      timestamp: 12_345,
    });
    const oversized = 'ø'.repeat(MAX_STDERR_BYTES);
    const script = `process.stderr.write(${JSON.stringify(`${checkpoint}\n`)}); process.stderr.write(Buffer.from(${JSON.stringify(oversized)}));`;

    const result = await spawnDelegateChild(run, {
      command: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5_000,
      onControlAck: acknowledge,
      onLine: update,
    });

    expect(result.exitCode).toBe(0);
    expect(acknowledge).toHaveBeenCalledWith(
      'checkpoint-1',
      'checkpoint',
      undefined,
    );
    expect(run.checkpoint).toMatchObject({
      state: 'acknowledged',
      acknowledgedAt: 12_345,
    });
    expect(update).toHaveBeenCalledOnce();
    expect(Buffer.byteLength(run.stderr, 'utf8')).toBeLessThanOrEqual(
      MAX_STDERR_BYTES,
    );
    expect(run.stderr).not.toContain('�');
  });

  test('ignores stderr acknowledgements after timeout termination begins', async () => {
    const acknowledge = vi.fn();
    const run = createRun('late stderr acknowledgement');
    const control = JSON.stringify({
      type: 'delegate_control_ack',
      controlId: 'late-pause',
      controlKind: 'pause',
      controlGeneration: 3,
    });
    const script = `setTimeout(() => process.stderr.write(${JSON.stringify(`${control}\n`)}), 80); setInterval(() => {}, 1000);`;

    const result = await spawnDelegateChild(run, {
      command: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 50,
      killGraceMs: 100,
      onControlAck: acknowledge,
      onLine: vi.fn(),
    });

    expect(result).toMatchObject({ timedOut: true, exitCode: 124 });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(run.stderr).not.toContain('delegate_control_ack');
  });

  test('preserves split UTF-8 sequences from child stdout', async () => {
    const run = createRun('split stdout');
    const event = JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'café' }],
        usage: {
          input: 0,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1,
        },
        timestamp: 1,
      },
    });
    const script = `const bytes = Buffer.from(${JSON.stringify(`${event}\n`)}); const split = bytes.indexOf(0xc3) + 1; process.stdout.write(bytes.subarray(0, split)); setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);`;

    const result = await spawnDelegateChild(run, {
      command: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5_000,
      onLine: vi.fn(),
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.stringify(run.messages)).toContain('café');
    expect(JSON.stringify(run.messages)).not.toContain('�');
  });

  test.each([
    ['success', 'done', 0, false],
    ['nonzero', 'failed', 7, false],
    ['timeout', 'killed', undefined, true],
  ] as const)('reconciles hosted %s terminal state', async (_label, status, exitCode, timedOut) => {
    const message = JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hosted result' }],
      },
    });
    await withHostedCase(
      {
        status,
        ...(exitCode === undefined ? {} : { exitCode }),
        timedOut,
        eventResponse: {
          events: [
            { offset: 2, stream: 'stdout', text: message, truncated: false },
            {
              offset: 1,
              stream: 'stdout',
              text: JSON.stringify({
                type: 'delegate_control_ack',
                controlId: 'checkpoint-1',
                controlKind: 'checkpoint',
              }),
              truncated: false,
            },
          ],
          truncated: false,
          complete: true,
          nextOffset: 3,
        },
      },
      async (calls, startInput) => {
        const run = createRun('hosted');
        run.checkpoint = { requestedAt: 1, state: 'requested' };
        const acknowledgements: string[] = [];
        const result = await runHostedDelegateChild(run, {
          command: 'pi',
          title: 'Delegate: Review',
          args: ['--mode', 'json'],
          cwd: process.cwd(),
          env: {},
          ownerSession: 'parent-session',
          processJobId: hostedJobId,
          timeoutMs: 100,
          onControlAck: (id) => acknowledgements.push(id),
          onLine: vi.fn(),
        });
        expect(calls).toEqual([
          'info',
          'start',
          'events',
          'inspect',
          'inspect',
        ]);
        expect(startInput()).toMatchObject({
          command: 'pi',
          argv: ['pi', '--mode', 'json'],
          exactEnv: true,
        });
        expect(acknowledgements).toEqual(['checkpoint-1']);
        expect(run.messages).toHaveLength(1);
        expect(result).toMatchObject({
          exitCode: timedOut ? 124 : (exitCode ?? 0),
          timedOut,
          wasAborted: false,
        });
      },
    );
  });

  test('observes an existing host job without sending start', async () => {
    const message = JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'reattached result' }],
      },
    });
    await withHostedCase(
      {
        status: 'done',
        exitCode: 0,
        eventResponse: {
          events: [
            { offset: 1, stream: 'stdout', text: message, truncated: false },
          ],
          truncated: false,
          complete: true,
          nextOffset: 2,
        },
      },
      async (calls) => {
        const run = createRun('reattach');
        const result = await runHostedDelegateChild(run, {
          command: 'must-not-be-started',
          args: ['original', 'launch', 'payload'],
          cwd: process.cwd(),
          env: { SECRET: 'must-not-be-read' },
          ownerSession: 'parent-session',
          processJobId: hostedJobId,
          observeExisting: true,
          timeoutMs: 100,
          onLine: vi.fn(),
        });
        expect(calls).toEqual([
          'info',
          'inspect',
          'events',
          'inspect',
          'inspect',
        ]);
        expect(calls).not.toContain('start');
        expect(run.messages).toHaveLength(1);
        expect(result).toMatchObject({ exitCode: 0, timedOut: false });
      },
    );
  });

  test('fails closed when an observed host job is unknown', async () => {
    await withHostedCase(
      { status: 'done', unknownJob: true },
      async (calls) => {
        await expect(
          runHostedDelegateChild(createRun('unknown reattach'), {
            command: 'must-not-be-started',
            args: [],
            cwd: process.cwd(),
            env: {},
            ownerSession: 'parent-session',
            processJobId: hostedJobId,
            observeExisting: true,
            timeoutMs: 100,
            onLine: vi.fn(),
          }),
        ).rejects.toThrow('Unknown hosted process job');
        expect(calls).toEqual(['info', 'inspect']);
      },
    );
  });

  test('retains a host-restart error while observing without relaunch', async () => {
    const hostRestartError =
      'Background job was marked failed because the process host restarted; the process was not adopted by PID.';
    await withHostedCase(
      { status: 'failed', error: hostRestartError },
      async (calls) => {
        const run = createRun('observed host restart');
        const result = await runHostedDelegateChild(run, {
          command: 'must-not-be-started',
          args: [],
          cwd: process.cwd(),
          env: {},
          ownerSession: 'parent-session',
          processJobId: hostedJobId,
          observeExisting: true,
          timeoutMs: 100,
          onLine: vi.fn(),
        });
        expect(calls).not.toContain('start');
        expect(result).toMatchObject({
          exitCode: 1,
          timedOut: false,
          hostError: hostRestartError,
        });
        expect(run.stderr).toContain(hostRestartError);
      },
    );
  });

  test.each([
    ['unknown operation', { infoResponse: 'unknown' as const }],
    ['missing capability', { infoResponse: 'missing' as const }],
    ['false capability', { exactEnvCapability: false }],
  ])('fails closed when the process host has no exactEnv capability (%s)', async (_label, capability) => {
    const setup: HostedCase = { status: 'done', ...capability };
    await withHostedCase(setup, async (calls) => {
      await expect(
        runHostedDelegateChild(createRun('capability negotiation'), {
          command: 'pi',
          args: [],
          cwd: process.cwd(),
          env: {},
          ownerSession: 'parent-session',
          processJobId: hostedJobId,
          timeoutMs: 100,
          onLine: vi.fn(),
        }),
      ).rejects.toThrow();
      expect(calls).toEqual(['info']);
    });
  });

  test('preserves terminal host errors as bounded diagnostics, not spawn failures', async () => {
    const hostRestartError =
      'Background job was marked failed because the process host restarted; the process was not adopted by PID.';
    await withHostedCase(
      { status: 'failed', error: hostRestartError },
      async (_calls) => {
        const run = createRun('host restart');
        const result = await runHostedDelegateChild(run, {
          command: 'pi',
          args: [],
          cwd: process.cwd(),
          env: {},
          ownerSession: 'parent-session',
          processJobId: hostedJobId,
          timeoutMs: 100,
          onLine: vi.fn(),
        });
        expect(result).toMatchObject({ exitCode: 1, timedOut: false });
        expect(result.spawnError).toBeUndefined();
        expect(result.hostError).toBe(hostRestartError);
        expect(run.stderr).toContain(hostRestartError);
      },
    );
  });

  test('rejects a supplied non-UUID hosted process job ID before launch', async () => {
    await expect(
      runHostedDelegateChild(createRun('invalid id'), {
        command: 'pi',
        args: [],
        cwd: process.cwd(),
        env: {},
        ownerSession: 'parent-session',
        processJobId: 'legacy-pid-42',
        timeoutMs: 100,
        onLine: vi.fn(),
      }),
    ).rejects.toThrow('canonical UUID');
  });

  test('stops the host process for explicit cancellation', async () => {
    await withHostedCase({ status: 'done', exitCode: 0 }, async (calls) => {
      const controller = new AbortController();
      controller.abort();
      const result = await runHostedDelegateChild(createRun('cancel'), {
        command: 'pi',
        args: [],
        cwd: process.cwd(),
        env: {},
        ownerSession: 'parent-session',
        processJobId: hostedJobId,
        timeoutMs: 100,
        signal: controller.signal,
        onLine: vi.fn(),
      });
      expect(calls).toContain('stop');
      expect(result).toMatchObject({ exitCode: 130, wasAborted: true });
    });
  });

  test('does not map an abort after terminal success to 130', async () => {
    const controller = new AbortController();
    let inspections = 0;
    await withHostedCase(
      {
        status: 'done',
        startStatus: 'running',
        exitCode: 0,
        onRequest(operation) {
          if (operation === 'inspect' && ++inspections === 2)
            controller.abort();
        },
      },
      async (calls) => {
        const result = await runHostedDelegateChild(createRun('late abort'), {
          command: 'pi',
          args: [],
          cwd: process.cwd(),
          env: {},
          ownerSession: 'parent-session',
          processJobId: hostedJobId,
          timeoutMs: 100,
          signal: controller.signal,
          onLine: vi.fn(),
        });
        expect(calls).not.toContain('stop');
        expect(result).toMatchObject({ exitCode: 0, wasAborted: false });
      },
    );
  });

  test('returns detached when detach fires during a delayed stop', async () => {
    const controller = new AbortController();
    const detach = new AbortController();
    await withHostedCase(
      {
        status: 'running',
        delayStopMs: 25,
        onRequest(operation) {
          if (operation === 'inspect' && !controller.signal.aborted)
            controller.abort();
          if (operation === 'stop') detach.abort();
        },
      },
      async (calls) => {
        const result = await runHostedDelegateChild(
          createRun('delayed stop detach'),
          {
            command: 'pi',
            args: [],
            cwd: process.cwd(),
            env: {},
            ownerSession: 'parent-session',
            processJobId: hostedJobId,
            timeoutMs: 100,
            signal: controller.signal,
            detachSignal: detach.signal,
            onLine: vi.fn(),
          },
        );
        expect(calls).toContain('stop');
        expect(result).toEqual({
          exitCode: -1,
          wasAborted: false,
          timedOut: false,
          detached: true,
        });
      },
    );
  });

  test('returns detached when detach fires during a delayed final inspect', async () => {
    const detach = new AbortController();
    let inspections = 0;
    await withHostedCase(
      {
        status: 'done',
        exitCode: 0,
        delayInspectMs: 25,
        onRequest(operation) {
          if (operation === 'inspect' && ++inspections === 2) detach.abort();
        },
      },
      async (calls) => {
        const result = await runHostedDelegateChild(
          createRun('delayed final inspect detach'),
          {
            command: 'pi',
            args: [],
            cwd: process.cwd(),
            env: {},
            ownerSession: 'parent-session',
            processJobId: hostedJobId,
            timeoutMs: 100,
            detachSignal: detach.signal,
            onLine: vi.fn(),
          },
        );
        expect(calls).toEqual([
          'info',
          'start',
          'events',
          'inspect',
          'inspect',
        ]);
        expect(result).toEqual({
          exitCode: -1,
          wasAborted: false,
          timedOut: false,
          detached: true,
        });
      },
    );
  });

  test('stops cancellation before terminal even when detach wins the race', async () => {
    const controller = new AbortController();
    const detach = new AbortController();
    let raced = false;
    await withHostedCase(
      {
        status: 'running',
        onRequest(operation) {
          if (operation !== 'inspect' || raced) return;
          raced = true;
          controller.abort();
          detach.abort();
        },
      },
      async (calls) => {
        const result = await runHostedDelegateChild(createRun('cancel race'), {
          command: 'pi',
          args: [],
          cwd: process.cwd(),
          env: {},
          ownerSession: 'parent-session',
          processJobId: hostedJobId,
          timeoutMs: 100,
          signal: controller.signal,
          detachSignal: detach.signal,
          onLine: vi.fn(),
        });
        expect(calls).toContain('stop');
        expect(result.detached).toBe(true);
      },
    );
  });

  test('detach alone leaves the hosted process running', async () => {
    const detach = new AbortController();
    let detached = false;
    await withHostedCase(
      {
        status: 'running',
        onRequest(operation) {
          if (operation === 'inspect' && !detached) {
            detached = true;
            detach.abort();
          }
        },
      },
      async (calls) => {
        const result = await runHostedDelegateChild(createRun('detach'), {
          command: 'pi',
          args: [],
          cwd: process.cwd(),
          env: {},
          ownerSession: 'parent-session',
          processJobId: hostedJobId,
          timeoutMs: 100,
          detachSignal: detach.signal,
          onLine: vi.fn(),
        });
        expect(calls).not.toContain('stop');
        expect(result.detached).toBe(true);
      },
    );
  });

  test('diagnoses truncated hosted event history without treating tails as transcript', async () => {
    await withHostedCase(
      {
        status: 'done',
        exitCode: 0,
        eventResponse: {
          events: [
            {
              offset: 4,
              stream: 'stdout',
              text: '{"type":"message_end"',
              truncated: true,
            },
          ],
          truncated: true,
          complete: true,
          nextOffset: 5,
        },
      },
      async (calls) => {
        const run = createRun('truncated hosted');
        const result = await runHostedDelegateChild(run, {
          command: 'pi',
          args: [],
          cwd: process.cwd(),
          env: {},
          ownerSession: 'parent-session',
          processJobId: hostedJobId,
          timeoutMs: 100,
          onLine: vi.fn(),
        });
        expect(calls).toEqual([
          'info',
          'start',
          'events',
          'inspect',
          'inspect',
        ]);
        expect(result).toMatchObject({ exitCode: 0, timedOut: false });
        expect(run.messages).toEqual([]);
        expect(run.stderr).toContain('truncated');
      },
    );
  });

  test('resolves a bounded temp home in a child command without touching the real home', async () => {
    const testHome = mkdtempSync(path.join(tmpdir(), 'delegate-child-home-'));
    const marker = path.join(testHome, 'resolution.json');
    const script = `const fs = require('node:fs'); const path = require('node:path'); const home = process.env.HOME; const target = path.join(home, '.local', 'delegate-check'); fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ home, target }));`;
    vi.stubEnv('HOME', testHome);

    try {
      const run = createRun('resolve home');
      const result = await spawnDelegateChild(run, {
        command: process.execPath,
        args: ['-e', script],
        cwd: testHome,
        env: { HOME: path.join(testHome, 'ignored-by-parent-policy') },
        timeoutMs: 5_000,
        onLine: vi.fn(),
      });
      const resolution = JSON.parse(readFileSync(marker, 'utf8')) as {
        home: string;
        target: string;
      };

      expect(result).toMatchObject({
        exitCode: 0,
        wasAborted: false,
        timedOut: false,
      });
      expect(resolution.home).toBe(testHome);
      expect(resolution.target).toBe(
        path.join(testHome, '.local', 'delegate-check'),
      );
      expect(resolution.target).not.toBe('/.local/delegate-check');
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});
