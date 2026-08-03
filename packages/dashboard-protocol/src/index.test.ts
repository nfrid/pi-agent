import { describe, expect, it } from 'vitest';
import {
  deriveSessionTitle,
  isBridgeEvent,
  MAX_FRAME_BYTES,
  parseFrame,
  serializeFrame,
  validateBridgeCommand,
  validateSessionRenameRequest,
  validateStartRuntimeRequest,
  type WorkspaceTarget,
  workspaceForPath,
} from './index.js';

describe('dashboard protocol', () => {
  it('matches the closest workspace and uses explicit sources as tie-breakers', () => {
    const workspace = (
      id: string,
      canonicalPath: string,
      source: WorkspaceTarget['source'],
    ): WorkspaceTarget => ({
      id,
      name: id,
      path: canonicalPath,
      canonicalPath,
      source,
      active: source === 'tmux',
    });
    const zoxideParent = workspace('zoxide-parent', '/Users/me/.pi', 'zoxide');
    const tmuxChild = workspace('pi-config', '/Users/me/.pi/agent', 'tmux');
    expect(
      workspaceForPath('/Users/me/.pi/agent', [zoxideParent, tmuxChild])?.id,
    ).toBe('pi-config');
    expect(
      workspaceForPath('/Users/me/.pi/project', [
        workspace('tmux-home', '/Users/me', 'tmux'),
        workspace('zoxide-project', '/Users/me/.pi/project', 'zoxide'),
      ])?.id,
    ).toBe('zoxide-project');
    expect(
      workspaceForPath('/workspace', [
        workspace('zoxide', '/workspace', 'zoxide'),
        workspace('configured', '/workspace', 'sesh-config'),
      ])?.id,
    ).toBe('configured');
  });

  it('round trips bounded commands', () => {
    const frame = {
      kind: 'command' as const,
      command: { id: '1', type: 'followUp' as const, text: 'continue' },
    };
    expect(parseFrame(serializeFrame(frame))).toEqual(frame);
  });

  it('rejects arbitrary commands and oversized frames', () => {
    expect(() =>
      validateBridgeCommand({ id: 'x', type: 'exec', command: 'rm -rf /' }),
    ).toThrow();
    expect(() => parseFrame('x'.repeat(MAX_FRAME_BYTES + 1))).toThrow(/size/);
  });

  it('validates rename commands and derives bounded first-user titles', () => {
    expect(
      validateBridgeCommand({
        id: 'x',
        type: 'setSessionName',
        name: ' Dashboard ',
      }),
    ).toEqual({ id: 'x', type: 'setSessionName', name: 'Dashboard' });
    expect(() =>
      validateBridgeCommand({
        id: 'x',
        type: 'setSessionName',
        name: 'Dashboard',
        extra: true,
      }),
    ).toThrow();
    expect(validateSessionRenameRequest({ name: '  Renamed  ' })).toEqual({
      name: 'Renamed',
    });
    expect(() => validateSessionRenameRequest({ name: 'x\n' })).toThrow();
    const title = deriveSessionTitle([
      { type: 'session', id: 's' },
      {
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '  fix\n  the   dashboard  ' }],
        },
      },
    ]);
    expect(title).toBe('fix the dashboard');
    expect(
      deriveSessionTitle([
        { type: 'message', message: { role: 'assistant', content: 'nope' } },
        {
          type: 'message',
          message: { role: 'user', content: 'x'.repeat(200) },
        },
      ]),
    ).toHaveLength(96);
  });

  it('strictly validates each bridge event variant', () => {
    const helloSnapshot = {
      runtimeId: 'r',
      ownership: 'external',
      pid: 1,
      cwd: '/tmp',
      liveState: 'idle',
      session: { id: 's', entries: [] },
      pendingInteractions: [],
    };
    expect(
      isBridgeEvent({
        type: 'runtime.hello',
        protocolVersion: 1,
        capabilities: { heartbeat: true },
        snapshot: helloSnapshot,
      }),
    ).toBe(true);
    expect(
      isBridgeEvent({
        type: 'runtime.hello',
        protocolVersion: 1,
        capabilities: { heartbeat: false },
        snapshot: helloSnapshot,
      }),
    ).toBe(false);
    expect(
      isBridgeEvent({
        type: 'runtime.hello',
        protocolVersion: 1,
        snapshot: { runtimeId: 'r', pid: 1 },
      }),
    ).toBe(false);
    expect(
      isBridgeEvent({
        type: 'runtime.stateChanged',
        state: 'working',
        snapshot: { pid: -1 },
      }),
    ).toBe(false);
    expect(
      isBridgeEvent({
        type: 'session.changed',
        session: { id: 's', entries: [], unexpected: true },
      }),
    ).toBe(false);
    expect(
      isBridgeEvent({
        type: 'interaction.resolved',
        interactionId: 'i',
      }),
    ).toBe(false);
    expect(() =>
      parseFrame(
        JSON.stringify({
          kind: 'event',
          seq: 1,
          event: { type: 'runtime.nope' },
        }),
      ),
    ).toThrow();
  });

  it('validates structured launch requests', () => {
    expect(
      validateStartRuntimeRequest({
        workspaceId: 'w',
        model: { provider: 'p', model: 'm' },
      }).workspaceId,
    ).toBe('w');
    expect(() =>
      validateStartRuntimeRequest({ workspaceId: '../etc' }),
    ).not.toThrow();
    expect(() => validateStartRuntimeRequest({ workspaceId: '' })).toThrow();
    expect(() =>
      validateStartRuntimeRequest({
        workspaceId: 'w',
        initialPrompt: 'x'.repeat(100_001),
      }),
    ).toThrow('initial prompt');
  });
});
