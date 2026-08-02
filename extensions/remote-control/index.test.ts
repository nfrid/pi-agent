import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type RuntimeSnapshot,
  serializeFrame,
} from '../../packages/dashboard-protocol/src/index';
import { BridgeClient } from './index';

const snapshot: RuntimeSnapshot = {
  runtimeId: 'runtime-test',
  ownership: 'external',
  pid: 1,
  cwd: '/tmp',
  liveState: 'idle',
  session: { id: 'session-test', entries: [] },
  pendingInteractions: [],
};

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1_000;
    const tick = () =>
      predicate()
        ? resolve()
        : Date.now() > deadline
          ? reject(new Error('timed out'))
          : setTimeout(tick, 5);
    tick();
  });
}

describe('remote-control bridge', () => {
  it('sends a full hello and acknowledges serialized daemon commands', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-bridge-'));
    const socketPath = path.join(directory, 'bridge.sock');
    let connection: net.Socket | undefined;
    const received: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
      connection = socket;
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          const frame = JSON.parse(line) as Record<string, unknown>;
          received.push(frame);
          if (frame.kind === 'command') {
            const command = frame.command as { id: string };
            socket.write(
              serializeFrame({
                kind: 'ack',
                id: command.id,
                ok: true,
                result: { accepted: true },
              }),
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = new BridgeClient({
      socketPath,
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      handleCommand: async (command) => ({ type: command.type }),
    });
    client.start();
    await waitFor(() =>
      received.some(
        (frame) =>
          (frame.event as { type?: string } | undefined)?.type ===
          'runtime.hello',
      ),
    );
    connection?.write(
      serializeFrame({
        kind: 'command',
        command: { id: 'daemon-1', type: 'abort' },
      }),
    );
    await waitFor(() =>
      received.some((frame) => frame.kind === 'ack' && frame.id === 'daemon-1'),
    );
    expect(
      received.find(
        (frame) =>
          (frame.event as { type?: string } | undefined)?.type ===
          'runtime.hello',
      ),
    ).toBeDefined();
    client.stop();
    connection?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
});
