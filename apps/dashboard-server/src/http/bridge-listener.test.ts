import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeListener } from './bridge-listener.js';

describe('BridgeListener', () => {
  const listeners: BridgeListener[] = [];
  let directory: string | undefined;

  afterEach(async () => {
    for (const listener of listeners.splice(0))
      await listener.close().catch(() => undefined);
    if (directory)
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    directory = undefined;
  });

  async function socketPath(): Promise<string> {
    directory = await mkdtemp(path.join(tmpdir(), 'pi-bridge-listener-'));
    return path.join(directory, 'bridge.sock');
  }

  it('refuses to replace a live bridge socket', async () => {
    const file = await socketPath();
    const owner = new BridgeListener(() => undefined);
    listeners.push(owner);
    await owner.listen(file);
    const thief = new BridgeListener(() => undefined);
    listeners.push(thief);
    await expect(thief.listen(file)).rejects.toThrow(/already in use/u);
    expect(existsSync(file)).toBe(true);
    await thief.close(file);
    expect(existsSync(file)).toBe(true);
  });

  it('replaces a stale socket file that nobody is listening on', async () => {
    const file = await socketPath();
    await writeFile(file, '');
    expect(existsSync(file)).toBe(true);
    const listener = new BridgeListener(() => undefined);
    listeners.push(listener);
    await listener.listen(file);
    expect(existsSync(file)).toBe(true);
    const client = net.createConnection(file);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    client.destroy();
  });
});
