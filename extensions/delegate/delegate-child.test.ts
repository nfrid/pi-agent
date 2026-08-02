import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildDelegateChildEnvironment,
  effectiveDelegateHome,
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
