import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildDelegateChildEnvironment,
  checkpointLeadMs,
  effectiveDelegateHome,
  MAX_STDERR_BYTES,
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
