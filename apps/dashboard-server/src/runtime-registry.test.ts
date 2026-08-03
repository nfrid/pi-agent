import { PassThrough } from 'node:stream';
import { type RuntimeSnapshot, serializeFrame } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import { RuntimeRegistry } from './runtime-registry.js';

const snapshot: RuntimeSnapshot = {
  runtimeId: 'runtime-1',
  ownership: 'managed',
  pid: 10,
  cwd: '/tmp/project',
  liveState: 'idle',
  session: { id: 'session-1', entries: [] },
  pendingInteractions: [],
};

function eventually<T>(read: () => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 500;
    const tick = () => {
      const value = read();
      if (value !== undefined) resolve(value);
      else if (Date.now() > deadline) reject(new Error('timed out'));
      else setTimeout(tick, 1);
    };
    tick();
  });
}

describe('runtime registry', () => {
  it('tombstones forgotten runtimes so leaked clients cannot reconnect', async () => {
    const registry = new RuntimeRegistry({ expectedToken: () => true });
    const first = new PassThrough();
    registry.accept(first as never);
    first.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: { type: 'runtime.hello', protocolVersion: 1, snapshot },
      }),
    );
    await eventually(() => registry.get('runtime-1'));
    expect(registry.forget('runtime-1')).toMatchObject({
      runtimeId: 'runtime-1',
    });
    expect(registry.get('runtime-1')).toBeUndefined();
    const reconnect = new PassThrough();
    registry.accept(reconnect as never);
    reconnect.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: { type: 'runtime.hello', protocolVersion: 1, snapshot },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(reconnect.destroyed).toBe(true);
  });

  it('allows the same managed runtime identity to reconnect after extension reload', async () => {
    const registry = new RuntimeRegistry({ expectedToken: () => true });
    const first = new PassThrough();
    registry.accept(first as never);
    first.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: { type: 'runtime.hello', protocolVersion: 1, snapshot },
      }),
    );
    await eventually(() => registry.get('runtime-1'));
    first.write(
      serializeFrame({
        kind: 'event',
        seq: 2,
        event: { type: 'runtime.goodbye', reason: 'reload' },
      }),
    );
    await eventually(() =>
      registry.get('runtime-1') === undefined ? true : undefined,
    );
    const replacement = new PassThrough();
    registry.accept(replacement as never);
    replacement.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: { type: 'runtime.hello', protocolVersion: 1, snapshot },
      }),
    );
    await eventually(() => registry.get('runtime-1'));
    expect(registry.isOnline('runtime-1')).toBe(true);
    replacement.destroy();
  });

  it('does not let state updates replace runtime identity or pid', async () => {
    const registry = new RuntimeRegistry({ expectedToken: () => true });
    const bridge = new PassThrough();
    registry.accept(bridge as never);
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: { type: 'runtime.hello', protocolVersion: 1, snapshot },
      }),
    );
    await eventually(() => registry.get('runtime-1'));
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 2,
        event: {
          type: 'runtime.stateChanged',
          state: 'working',
          snapshot: {
            runtimeId: 'attacker',
            ownership: 'external',
            pid: 999,
            cwd: '/tmp/other',
          },
        },
      }),
    );
    await eventually(() => registry.get('runtime-1')?.liveState === 'working');
    expect(registry.get('runtime-1')).toMatchObject({
      runtimeId: 'runtime-1',
      ownership: 'managed',
      pid: 10,
      cwd: '/tmp/other',
    });
    bridge.destroy();
  });

  it('does not move a queued command to a replacement connection', async () => {
    const registry = new RuntimeRegistry({ expectedToken: () => true });
    const first = new PassThrough();
    const firstFrames: string[] = [];
    first.on('data', (chunk) =>
      firstFrames.push(...String(chunk).split('\\n').filter(Boolean)),
    );
    registry.accept(first as never);
    first.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: { type: 'runtime.hello', protocolVersion: 1, snapshot },
      }),
    );
    await eventually(() => registry.get('runtime-1'));
    const commandPromise = registry.sendCommand('runtime-1', {
      type: 'abort',
    });
    await eventually(() =>
      firstFrames.some((line) => line.includes('command')),
    );

    const replacement = new PassThrough();
    const replacementFrames: string[] = [];
    replacement.on('data', (chunk) =>
      replacementFrames.push(...String(chunk).split('\\n').filter(Boolean)),
    );
    registry.accept(replacement as never);
    replacement.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: { type: 'runtime.hello', protocolVersion: 1, snapshot },
      }),
    );
    await expect(commandPromise).rejects.toThrow('disconnected');
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(
      replacementFrames.some((line) => line.includes('"kind":"command"')),
    ).toBe(false);
    replacement.destroy();
  });

  it('registers full snapshots, serializes commands, and ignores duplicate events', async () => {
    const registry = new RuntimeRegistry({
      expectedToken: (_id, token) => token === 'one',
    });
    const bridge = new PassThrough();
    const frames: string[] = [];
    bridge.on('data', (chunk) => {
      frames.push(...String(chunk).split('\n').filter(Boolean));
    });
    registry.accept(bridge as never);
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: {
          type: 'runtime.hello',
          protocolVersion: 1,
          token: 'one',
          snapshot,
        },
      }),
    );
    await eventually(() => registry.get('runtime-1'));
    expect(registry.isOnline('runtime-1')).toBe(true);

    const commandPromise = registry.sendCommand('runtime-1', {
      type: 'prompt',
      text: 'hello',
    });
    const command = await eventually(() =>
      frames
        .map((line) => {
          try {
            return JSON.parse(line) as {
              kind?: string;
              command?: { id: string };
            };
          } catch {
            return undefined;
          }
        })
        .find((frame) => frame?.kind === 'command'),
    );
    if (!command.command?.id) throw new Error('command was not sent');
    bridge.write(
      serializeFrame({
        kind: 'ack',
        id: command.command.id,
        ok: true,
        result: { accepted: true },
      }),
    );
    await expect(commandPromise).resolves.toEqual({ accepted: true });

    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 2,
        event: {
          type: 'runtime.stateChanged',
          state: 'working',
          snapshot: {
            session: {
              id: 'session-1',
              entries: [{ type: 'message', id: 'live-entry' }],
            },
          },
        },
      }),
    );
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 2,
        event: { type: 'runtime.stateChanged', state: 'idle' },
      }),
    );
    await eventually(() =>
      registry.get('runtime-1')?.liveState === 'working' ? true : undefined,
    );
    expect(registry.get('runtime-1')).toMatchObject({
      liveState: 'working',
      session: { entries: [{ id: 'live-entry' }] },
    });
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 3,
        event: { type: 'runtime.goodbye' },
      }),
    );
    await eventually(() =>
      registry.get('runtime-1') === undefined ? true : undefined,
    );
  });
});
