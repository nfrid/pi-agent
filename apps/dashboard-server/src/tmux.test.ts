import type { WorkspaceTarget } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
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
