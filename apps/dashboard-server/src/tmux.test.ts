import type { WorkspaceTarget } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  parseNewWindowOutput,
  sanitizeTmuxName,
  TmuxAdapter,
  type TmuxCommandRunner,
} from './tmux.js';

class FakeRunner implements TmuxCommandRunner {
  calls: string[][] = [];
  async run(args: readonly string[]) {
    this.calls.push([...args]);
    return {
      stdout: args[0] === 'list-sessions' ? 'project\n' : '@4\t%9\n',
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

  it('rejects malformed placements and unsafe names', () => {
    expect(() => parseNewWindowOutput('bad output', 'project')).toThrow();
    expect(sanitizeTmuxName('a:b')).not.toContain(':');
  });
});
