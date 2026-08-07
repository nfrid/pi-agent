import type { WorkspaceTarget } from '@pi-dashboard/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  parseNewWindowOutput,
  sanitizeTmuxName,
  TmuxAdapter,
  type TmuxCommandRunner,
  TmuxRuntimeProvider,
} from './tmux.js';

class FakeRunner implements TmuxCommandRunner {
  calls: string[][] = [];
  async run(args: readonly string[]) {
    this.calls.push([...args]);
    return {
      stdout:
        args[0] === 'list-sessions'
          ? 'project\n'
          : args[0] === 'list-windows'
            ? '@4\n'
            : '@4:%9\n',
      stderr: '',
    };
  }
}

describe('tmux adapter', () => {
  it('uses stable IDs and argv-safe fixed Pi launch arguments', async () => {
    const runner = new FakeRunner();
    const workspace: WorkspaceTarget = {
      id: 'w',
      name: 'project',
      path: '/tmp',
      canonicalPath: '/tmp',
      source: 'tmux',
      tmuxSession: 'project',
      active: true,
    };
    const adapter = new TmuxAdapter(runner);
    const placement = await adapter.newManagedWindow({
      workspace,
      name: 'mobile; no shell',
      runtimeId: 'r',
      socketPath: '/tmp/socket',
      token: 'token',
      model: { provider: 'p', model: 'm' },
    });
    expect(placement).toMatchObject({ tmuxWindowId: '@4', tmuxPaneId: '%9' });
    expect(runner.calls.at(-1)).toEqual(
      expect.arrayContaining([
        'new-window',
        '-d',
        '-P',
        '-F',
        '#{window_id}:#{pane_id}',
        '-t',
        'project',
        'pi',
        '--approve',
        '--provider',
        'p',
        '--model',
        'm',
      ]),
    );
    expect(runner.calls.at(-1)?.join(' ')).not.toContain('mobile; no shell');
    expect(runner.calls.at(-1)).not.toContain('--tools');
  });

  it('uses a fail-closed read-only Pi tool allowlist for read launches', async () => {
    const runner = new FakeRunner();
    const adapter = new TmuxAdapter(runner);
    await adapter.newManagedWindow({
      workspace: {
        id: 'w',
        name: 'project',
        path: '/tmp',
        canonicalPath: '/tmp',
        source: 'tmux',
        tmuxSession: 'project',
        active: true,
      },
      runtimeId: 'read-runtime',
      socketPath: '/tmp/socket',
      token: 'token',
      mode: 'read',
    });
    const args = runner.calls.at(-1) ?? [];
    expect(args).toContain('--tools');
    expect(args[args.indexOf('--tools') + 1]).toBe('read');
    expect(args).not.toEqual(expect.arrayContaining(['bash', 'edit', 'write']));
    expect(args).not.toContain('--extension');
  });

  it('exposes the tmux launch through the provider-neutral lifecycle contract', async () => {
    const runner = new FakeRunner();
    const provider = new TmuxRuntimeProvider(new TmuxAdapter(runner));
    const binding = await provider.start({
      runtimeId: 'runtime-1',
      cwd: '/tmp',
      socketPath: '/tmp/socket',
      launchToken: 'launch',
      identityToken: 'identity',
      workspace: {
        id: 'w',
        name: 'project',
        sessionId: 'project',
        active: true,
      },
    });
    expect(binding).toEqual({
      runtimeId: 'runtime-1',
      location: {
        id: 'project|@4|%9',
        sessionId: 'project',
        windowId: '@4',
        paneId: '%9',
        displayTarget: 'project:@4',
      },
    });
    await provider.stop(binding);
    expect(runner.calls.at(-1)).toEqual(['kill-window', '-t', 'project:@4']);
  });

  it('rejects a stale active Sesh flag before creating a managed window', async () => {
    const hasSession = vi.fn().mockResolvedValue(false);
    const newManagedWindow = vi.fn();
    const provider = new TmuxRuntimeProvider({
      hasSession,
      newManagedWindow,
    } as unknown as TmuxAdapter);

    await expect(
      provider.start({
        runtimeId: 'runtime-stale-session',
        cwd: '/tmp',
        socketPath: '/tmp/socket',
        launchToken: 'launch',
        identityToken: 'identity',
        workspace: {
          id: 'w',
          name: 'project',
          sessionId: 'project',
          active: true,
        },
      }),
    ).rejects.toThrow(
      'This workspace has no active tmux session yet. Open it through Sesh on the Mac first.',
    );
    expect(hasSession).toHaveBeenCalledWith('project');
    expect(newManagedWindow).not.toHaveBeenCalled();
  });

  it('parses the literal-delimited placement format', () => {
    expect(parseNewWindowOutput('@4:%9\n', 'project')).toEqual({
      tmuxWindowId: '@4',
      tmuxPaneId: '%9',
      displayTarget: 'project:@4',
    });
  });

  it('rejects malformed placements and unsafe names', () => {
    expect(() => parseNewWindowOutput('@4\\t%9\n', 'project')).toThrow();
    expect(() => parseNewWindowOutput('bad output', 'project')).toThrow();
    expect(sanitizeTmuxName('a:b')).not.toContain(':');
  });
});
