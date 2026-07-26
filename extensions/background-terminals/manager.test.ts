import { describe, expect, it, vi } from 'vitest';
import { BackgroundManager } from './manager';

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function nodeCommand(script: string): string {
  return `${quoteShell(process.execPath)} -e ${quoteShell(script)}`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  check: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withManager(
  run: (manager: BackgroundManager) => Promise<void>,
): Promise<void> {
  const manager = new BackgroundManager();
  try {
    await run(manager);
  } finally {
    await manager.dispose();
  }
}

describe('BackgroundManager', () => {
  it('executes commands with Bash rather than the login shell', async () => {
    await withManager(async (manager) => {
      const started = manager.start({
        command: 'printf %s "$BASH_VERSION"',
        title: 'shell check',
        cwd: process.cwd(),
      });
      const settled = await manager.peek(started.id, 2_000);

      expect(settled.status).toBe('done');
      expect(settled.stdout.text).not.toBe('');
    });
  });

  it('captures stdout and stderr separately and reports a successful exit', async () => {
    await withManager(async (manager) => {
      const started = manager.start({
        command: nodeCommand(
          "process.stdout.write('hello'); process.stderr.write('warning')",
        ),
        title: 'capture',
        cwd: process.cwd(),
      });
      const settled = await manager.peek(started.id, 2_000);

      expect(settled.status).toBe('done');
      expect(settled.exitCode).toBe(0);
      expect(settled.stdout.text).toBe('hello');
      expect(settled.stderr.text).toBe('warning');
    });
  });

  it('returns a running snapshot when peek times out', async () => {
    await withManager(async (manager) => {
      const started = manager.start({
        command: nodeCommand('setInterval(() => {}, 1000)'),
        title: 'server',
        cwd: process.cwd(),
      });
      const snapshot = await manager.peek(started.id, 20);

      expect(snapshot.status).toBe('running');
    });
  });

  it('lets an aborted peek leave the process running', async () => {
    await withManager(async (manager) => {
      const started = manager.start({
        command: nodeCommand('setInterval(() => {}, 1000)'),
        title: 'server',
        cwd: process.cwd(),
      });
      const controller = new AbortController();
      const pending = manager.peek(started.id, 2_000, controller.signal);
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(manager.get(started.id)?.status).toBe('running');
    });
  });

  it('suppresses asynchronous settlement while peek is observing it', async () => {
    const onSettled = vi.fn();
    const manager = new BackgroundManager({ onSettled });
    try {
      const started = manager.start({
        command: nodeCommand('setTimeout(() => {}, 20)'),
        title: 'short task',
        cwd: process.cwd(),
      });
      const settled = await manager.peek(started.id, 2_000);

      expect(settled.status).toBe('done');
      expect(onSettled).not.toHaveBeenCalled();
    } finally {
      await manager.dispose();
    }
  });

  it('suppresses asynchronous settlement while stop is observing it', async () => {
    const onSettled = vi.fn();
    const manager = new BackgroundManager({ onSettled });
    try {
      const started = manager.start({
        command: nodeCommand('setInterval(() => {}, 1000)'),
        title: 'server',
        cwd: process.cwd(),
      });
      const [stopped] = await manager.stop([started.id]);

      expect(stopped.status).toBe('killed');
      expect(onSettled).not.toHaveBeenCalled();
    } finally {
      await manager.dispose();
    }
  });

  it('delivers unobserved settlement once', async () => {
    let resolveDelivery = (_snapshot: unknown) => {};
    const delivered = new Promise<unknown>((resolve) => {
      resolveDelivery = resolve;
    });
    const onSettled = vi.fn(resolveDelivery);
    const manager = new BackgroundManager({ onSettled });
    try {
      const started = manager.start({
        command: nodeCommand('process.exitCode = 3'),
        title: 'failure',
        cwd: process.cwd(),
      });
      const settled = await delivered;

      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(settled).toMatchObject({
        id: started.id,
        status: 'failed',
        exitCode: 3,
      });
    } finally {
      await manager.dispose();
    }
  });

  it.runIf(process.platform !== 'win32')(
    'cleans up descendants after the shell exits',
    async () => {
      await withManager(async (manager) => {
        const started = manager.start({
          command: nodeCommand(
            "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); child.unref()",
          ),
          title: 'backgrounding shell',
          cwd: process.cwd(),
        });
        const settled = await manager.peek(started.id, 2_000);
        const pid = Number(settled.stdout.text.trim());

        expect(settled.status).toBe('done');
        expect(pid).toBeGreaterThan(0);
        await waitUntil(() => !processExists(pid), 1_000);
      });
    },
  );

  it('bounds the retained display command', async () => {
    await withManager(async (manager) => {
      const started = manager.start({
        command: `printf %s ${quoteShell('x'.repeat(2_000))}`,
        title: 'large command',
        cwd: process.cwd(),
      });
      const settled = await manager.peek(started.id, 2_000);

      expect(settled.command.length).toBe(1_001);
      expect(settled.command.endsWith('…')).toBe(true);
    });
  });

  it('disposes running processes without delivering completion', async () => {
    const onSettled = vi.fn();
    const manager = new BackgroundManager({ onSettled });
    const started = manager.start({
      command: nodeCommand('setInterval(() => {}, 1000)'),
      title: 'server',
      cwd: process.cwd(),
    });

    await manager.dispose();

    expect(onSettled).not.toHaveBeenCalled();
    expect(manager.get(started.id)).toBeUndefined();
  });
});
