import { PassThrough } from 'node:stream';
import {
  createRuntimeCapabilitySnapshot,
  type ExtensionManifest,
} from '@pi-dashboard/extension-contributions';
import { type RuntimeSnapshot, serializeFrame } from '@pi-dashboard/protocol';
import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeRegistry } from './runtime-registry.js';

const actionManifest: ExtensionManifest = {
  id: 'registry-test',
  version: '1',
  actions: [
    {
      id: 'registry-test.run',
      inputSchema: Type.Object(
        { value: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    },
  ],
  renderers: [],
};
const actionCapabilities = createRuntimeCapabilitySnapshot(
  [actionManifest],
  [{ id: 'registry-test', version: '1', available: true }],
);

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

  it('installs either direct legacy hello capability field with an empty absent side', async () => {
    const cases = [
      {
        capabilities: {
          capabilitySummaries: [
            { id: 'legacy-capability', version: '1', available: true },
          ],
        },
        expected: {
          version: 1,
          capabilities: [
            { id: 'legacy-capability', version: '1', available: true },
          ],
          manifests: [],
        },
      },
      {
        capabilities: {
          manifests: [
            { id: 'legacy-manifest', version: '1', actions: [], renderers: [] },
          ],
        },
        expected: {
          version: 1,
          capabilities: [],
          manifests: [
            { id: 'legacy-manifest', version: '1', actions: [], renderers: [] },
          ],
        },
      },
    ] as const;
    for (const [index, candidate] of cases.entries()) {
      const registry = new RuntimeRegistry({ expectedToken: () => true });
      const bridge = new PassThrough();
      registry.accept(bridge as never);
      bridge.write(
        serializeFrame({
          kind: 'event',
          seq: 1,
          event: {
            type: 'runtime.hello',
            protocolVersion: 1,
            capabilities: candidate.capabilities,
            snapshot: { ...snapshot, runtimeId: `legacy-${index}` },
          },
        }),
      );
      await eventually(() => registry.get(`legacy-${index}`));
      expect(registry.get(`legacy-${index}`)?.capabilities).toEqual(
        candidate.expected,
      );
      bridge.destroy();
      registry.close();
    }
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

  it('ignores duplicate capability patches without dropping the runtime connection', async () => {
    const registry = new RuntimeRegistry({ expectedToken: () => true });
    const bridge = new PassThrough();
    registry.accept(bridge as never);
    const initialCapabilities = {
      version: 1 as const,
      capabilities: [{ id: 'initial', version: '1' }],
      manifests: [],
    };
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: {
          type: 'runtime.hello',
          protocolVersion: 1,
          snapshot: { ...snapshot, capabilities: initialCapabilities },
        },
      }),
    );
    await eventually(() => registry.get('runtime-1'));
    bridge.write(
      `${JSON.stringify({
        kind: 'event',
        seq: 2,
        event: {
          type: 'runtime.heartbeat',
          state: 'working',
          snapshot: {
            capabilities: {
              version: 1,
              capabilities: [
                { id: 'duplicate', version: '1' },
                { id: 'duplicate', version: '2' },
              ],
              manifests: [],
            },
          },
        },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(bridge.destroyed).toBe(false);
    expect(registry.get('runtime-1')?.capabilities).toEqual(
      initialCapabilities,
    );

    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 3,
        event: {
          type: 'runtime.stateChanged',
          state: 'working',
          snapshot: {
            capabilities: {
              version: 1,
              capabilities: [{ id: 'updated', version: '1' }],
              manifests: [],
            },
          },
        },
      }),
    );
    await eventually(() =>
      registry.get('runtime-1')?.capabilities?.capabilities[0]?.id === 'updated'
        ? true
        : undefined,
    );
    bridge.destroy();
  });

  it('redacts image bytes from untrusted snapshots and live events', async () => {
    const changes: unknown[] = [];
    const registry = new RuntimeRegistry({
      expectedToken: () => true,
      onChange: (change) => changes.push(change),
    });
    const bridge = new PassThrough();
    registry.accept(bridge as never);
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: {
          type: 'runtime.hello',
          protocolVersion: 1,
          snapshot: {
            ...snapshot,
            session: {
              ...snapshot.session,
              entries: [
                {
                  type: 'message',
                  message: {
                    role: 'user',
                    content: [
                      {
                        type: 'image',
                        mimeType: 'image/png',
                        data: 'hello-secret',
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      }),
    );
    await eventually(() => registry.get('runtime-1'));
    expect(JSON.stringify(registry.get('runtime-1'))).not.toContain(
      'hello-secret',
    );
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 2,
        event: {
          type: 'message.finished',
          sessionId: 'session-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  mediaType: 'image/jpeg',
                  data: 'event-secret',
                },
              },
            ],
          },
        },
      }),
    );
    await eventually(() => (changes.length >= 2 ? changes.at(-1) : undefined));
    expect(JSON.stringify(changes)).not.toContain('event-secret');
    expect(changes.at(-1)).toMatchObject({
      event: {
        message: {
          content: [
            {
              type: 'image',
              source: { type: 'base64', omitted: true },
            },
          ],
        },
      },
    });
    bridge.destroy();
  });

  it('validates semantic action input before queueing and rejects duplicate IDs', async () => {
    const registry = new RuntimeRegistry({ expectedToken: () => true });
    const bridge = new PassThrough();
    const frames: string[] = [];
    bridge.on('data', (chunk) =>
      frames.push(...String(chunk).split('\n').filter(Boolean)),
    );
    registry.accept(bridge as never);
    bridge.write(
      serializeFrame({
        kind: 'event',
        seq: 1,
        event: {
          type: 'runtime.hello',
          protocolVersion: 1,
          snapshot: { ...snapshot, capabilities: actionCapabilities },
        },
      }),
    );
    await eventually(() => registry.get('runtime-1'));
    await expect(
      registry.sendCommand('runtime-1', {
        id: 'invalid-input',
        type: 'action.invoke',
        actionId: 'registry-test.run',
        input: { wrong: true },
      }),
    ).rejects.toThrow('Invalid input');
    expect(frames.some((line) => line.includes('invalid-input'))).toBe(false);

    const commandPromise = registry.sendCommand('runtime-1', {
      id: 'stable-action-id',
      type: 'action.invoke',
      actionId: 'registry-test.run',
      input: { value: 'ok' },
    });
    const command = await eventually(() =>
      frames
        .map(
          (line) =>
            JSON.parse(line) as { kind?: string; command?: { id: string } },
        )
        .find((frame) => frame.kind === 'command'),
    );
    bridge.write(
      serializeFrame({
        kind: 'ack',
        id: command.command?.id ?? 'stable-action-id',
        ok: true,
        result: { accepted: true },
      }),
    );
    await expect(commandPromise).resolves.toEqual({ accepted: true });
    await expect(
      registry.sendCommand('runtime-1', {
        id: 'stable-action-id',
        type: 'action.invoke',
        actionId: 'registry-test.run',
        input: { value: 'ok' },
      }),
    ).rejects.toThrow('Duplicate semantic action command ID');
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

  it('sends queue draft edits without waiting behind a semantic command', async () => {
    const registry = new RuntimeRegistry({ expectedToken: () => true });
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
        event: { type: 'runtime.hello', protocolVersion: 1, snapshot },
      }),
    );
    await eventually(() => registry.get('runtime-1'));

    const blocking = registry.sendCommand('runtime-1', {
      id: 'blocking',
      type: 'abort',
    });
    await eventually(() =>
      frames.some((line) => line.includes('"id":"blocking"')),
    );
    const draft = registry.sendCommand('runtime-1', {
      id: 'draft-now',
      type: 'queue.add',
      clientId: 'draft-1',
      mode: 'steer',
      text: 'deliver at the next boundary',
    });
    await eventually(() =>
      frames.some((line) => line.includes('"id":"draft-now"')),
    );
    bridge.write(
      serializeFrame({
        kind: 'ack',
        id: 'draft-now',
        ok: true,
        result: { accepted: true },
      }),
    );
    await expect(draft).resolves.toEqual({ accepted: true });
    let blockingSettled = false;
    void blocking.finally(() => {
      blockingSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(blockingSettled).toBe(false);
    bridge.write(
      serializeFrame({
        kind: 'ack',
        id: 'blocking',
        ok: true,
        result: { accepted: true },
      }),
    );
    await expect(blocking).resolves.toEqual({ accepted: true });
    bridge.destroy();
  });

  it('recycles a connection when backpressure outlives the command timeout', async () => {
    const registry = new RuntimeRegistry({
      expectedToken: () => true,
      commandTimeoutMs: 10,
    });
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
    vi.spyOn(bridge, 'write').mockReturnValue(false);
    const first = registry.sendCommand('runtime-1', { type: 'abort' });
    const queued = registry.sendCommand('runtime-1', { type: 'abort' });
    await expect(first).rejects.toThrow(
      'Runtime command acknowledgement timed out.',
    );
    await expect(queued).rejects.toThrow('Runtime bridge disconnected.');
    expect(bridge.destroyed).toBe(true);
  });

  it('rejects commands beyond the finite per-runtime queue', async () => {
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

    const promises = Array.from({ length: 80 }, () =>
      registry.sendCommand('runtime-1', { type: 'abort' }),
    );
    const settled = Promise.allSettled(promises);
    bridge.destroy();
    const results = await settled;
    expect(
      results.filter(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof Error &&
          result.reason.message === 'Runtime command queue is full.',
      ).length,
    ).toBeGreaterThan(0);
    bridge.destroy();
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
