import { PiSessionOwnershipError } from '@earendil-works/pi-client';
import { hydrateTranscript } from '@pi-dashboard/domain';
import type { RuntimeStartInput } from '@pi-dashboard/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  PiClientRuntimeProvider,
  RuntimeProviderRouter,
} from './pi-server-runtime.js';
import { RuntimeRegistry } from './runtime-registry.js';

function nativeSession() {
  return {
    id: 'pi-session-1',
    cwd: '/tmp/worktree',
    createdAt: 1,
    updatedAt: 1,
    phase: 'idle' as const,
    model: { provider: 'test', id: 'model' },
    thinkingLevel: 'off' as const,
    attached: true,
    locked: true,
    revision: 1,
    transcript: [] as unknown[],
    queuedSteer: [],
    queuedSteerCount: 0,
  };
}

function input(patch: Partial<RuntimeStartInput> = {}): RuntimeStartInput {
  return {
    runtimeId: 'runtime-pi-1',
    runtimeProvider: 'pi-server',
    cwd: '/tmp/worktree',
    socketPath: '/tmp/pi-server.sock',
    launchToken: 'launch-token',
    identityToken: 'identity-token',
    workspace: { id: 'workspace-1', name: 'workspace', active: true },
    ...patch,
  };
}

function fakeClient() {
  type FakeSession = Omit<ReturnType<typeof nativeSession>, 'phase'> & {
    phase: 'idle' | 'turn';
  };
  let current: FakeSession = nativeSession();
  const listeners = new Set<(snapshot: FakeSession) => void>();
  const connectionListeners = new Set<(change: { state: string }) => void>();
  const setPhase = (phase: FakeSession['phase']): void => {
    current = { ...current, phase };
    listeners.forEach((listener) => {
      listener(current);
    });
  };
  const disconnect = (): void => {
    connectionListeners.forEach((listener) => {
      listener({ state: 'disconnected' });
    });
  };
  const setTranscript = (transcript: unknown[]): void => {
    current = { ...current, transcript };
  };
  const lease = {
    id: current.id,
    get active() {
      return true;
    },
    get attached() {
      return true;
    },
    get snapshot() {
      return current;
    },
    subscribe(listener: (snapshot: typeof current) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onEvent: () => () => undefined,
    detach: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    prompt: vi.fn(async () => {
      setPhase('turn');
      return current;
    }),
    steer: vi.fn(async () => current),
    abort: vi.fn(async () => current),
    setModel: vi.fn(async () => current),
    setThinking: vi.fn(async () => current),
  };
  return {
    lease,
    client: {
      dispose: vi.fn(async () => undefined),
      onConnectionStateChange: (
        listener: (change: { state: string }) => void,
      ) => {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      },
      get snapshot() {
        return undefined;
      },
      connect: vi.fn(async () => undefined),
      createSession: vi.fn(async () => lease),
      acquireSession: vi.fn(async () => lease),
    },
    disconnect,
    setPhase,
    setTranscript,
  };
}

describe('PiClient runtime provider experiment', () => {
  it('creates a leased session, receives a durable prompt, and cleans it up', async () => {
    const fake = fakeClient();
    const changes: unknown[] = [];
    const registry = new RuntimeRegistry({
      expectedToken: () => true,
      onChange: (change) => changes.push(change),
    });
    const provider = new PiClientRuntimeProvider(registry, {
      clientFactory: async () => fake.client as never,
    });
    const binding = await provider.start(input());

    expect(fake.client.createSession).toHaveBeenCalledOnce();
    expect(registry.get('runtime-pi-1')).toMatchObject({
      session: { id: 'pi-session-1' },
      ownership: 'managed',
    });
    expect(registry.transportProvenance('runtime-pi-1')?.runtimeSeq).toBe(1);
    await registry.sendCommand('runtime-pi-1', {
      id: 'prompt-1',
      type: 'prompt',
      text: 'do the work',
    });
    expect(registry.transportProvenance('runtime-pi-1')?.runtimeSeq).toBe(5);
    for (let index = 0; index < 70; index += 1)
      await registry.sendCommand('runtime-pi-1', {
        id: `prompt-${index + 2}`,
        type: 'prompt',
        text: `sequential-${index}`,
      });
    expect(fake.lease.prompt).toHaveBeenCalledTimes(71);
    fake.setPhase('idle');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      changes.some(
        (change) =>
          (change as { kind?: string; event?: { type?: string } }).kind ===
            'event' &&
          (change as { event?: { type?: string } }).event?.type ===
            'agent.settled',
      ),
    ).toBe(true);
    expect(
      changes.some(
        (change) => (change as { kind?: string }).kind === 'registered',
      ),
    ).toBe(true);
    await expect(
      registry.sendCommand('runtime-pi-1', {
        id: 'shutdown-1',
        type: 'shutdown',
      }),
    ).resolves.toEqual({ accepted: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.get('runtime-pi-1')).toBeUndefined();

    await provider.stop(binding);
    expect(fake.lease.dispose).toHaveBeenCalledOnce();
    expect(fake.client.dispose).toHaveBeenCalledOnce();
  });

  it('uses exclusive acquire for an existing session and falls back before ownership', async () => {
    const fake = fakeClient();
    const pi = new PiClientRuntimeProvider(undefined, {
      clientFactory: async () => fake.client as never,
    });
    const tmux = {
      start: vi.fn(async () => ({
        runtimeId: 'runtime-pi-1',
        location: { id: 'tmux' },
      })),
      attach: vi.fn(async (request) => request),
      stop: vi.fn(),
      send: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };
    const unavailable = {
      start: vi.fn(async () => {
        throw new Error('Pi server unavailable');
      }),
      attach: vi.fn(),
      stop: vi.fn(),
      send: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };
    const router = new RuntimeProviderRouter(
      tmux as never,
      unavailable as never,
    );
    await router.start(input());
    expect(tmux.start).toHaveBeenCalledOnce();
    const ownershipError = new PiSessionOwnershipError(
      'pi-session-1',
      'already exclusively leased',
    );
    const blockedRouter = new RuntimeProviderRouter(
      tmux as never,
      {
        start: vi.fn(async () => {
          throw ownershipError;
        }),
      } as never,
    );
    await expect(blockedRouter.start(input())).rejects.toBe(ownershipError);
    expect(tmux.start).toHaveBeenCalledOnce();
    const restoredRouter = new RuntimeProviderRouter(tmux as never, undefined);
    const restored = await restoredRouter.attach({
      runtimeId: 'restored-runtime',
      location: {
        id: 'dashboard:restored',
        sessionId: 'tmux-session',
        windowId: '@1',
        paneId: '%1',
      },
    });
    expect(restored.runtimeId).toBe('restored-runtime');
    expect(tmux.attach).toHaveBeenCalledOnce();

    const offRouter = new RuntimeProviderRouter(tmux as never, undefined);
    await offRouter.start(input({ runtimeId: 'runtime-off' }));
    expect(tmux.start).toHaveBeenCalledTimes(2);
    const readOnlyRouter = new RuntimeProviderRouter(
      tmux as never,
      { start: vi.fn() } as never,
    );
    await readOnlyRouter.start(input({ mode: 'read' }));
    expect(tmux.start).toHaveBeenCalledTimes(3);

    const attached = await pi.start({ ...input(), sessionId: 'pi-session-1' });
    expect(fake.client.acquireSession).toHaveBeenCalledWith('pi-session-1', {
      mode: 'exclusive',
    });
    await pi.send(attached, { type: 'steer', text: 'next' });
    expect(fake.lease.steer).toHaveBeenCalledWith('next');
    await pi.stop(attached);
  });

  it('normalizes native tool transcript items for dashboard hydration', async () => {
    const fake = fakeClient();
    fake.setTranscript([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            toolCallId: 'call-1',
            toolName: 'read',
            input: { path: 'README.md' },
          },
        ],
        model: { provider: 'test', id: 'model' },
        timestamp: 2,
        status: 'complete',
        stopReason: 'toolUse',
      },
      {
        id: 'tool-1',
        role: 'tool',
        toolCallId: 'call-1',
        toolName: 'read',
        input: { path: 'README.md' },
        content: [{ type: 'text', text: 'contents' }],
        timestamp: 3,
        status: 'complete',
        isError: false,
      },
    ]);
    const registry = new RuntimeRegistry({ expectedToken: () => true });
    const provider = new PiClientRuntimeProvider(registry, {
      clientFactory: async () => fake.client as never,
    });
    const binding = await provider.start(input());
    const projection = hydrateTranscript(
      registry.get('runtime-pi-1')?.session.entries ?? [],
    );

    expect(projection.items['call-1']).toMatchObject({
      kind: 'tool',
      name: 'read',
      arguments: { path: 'README.md' },
      result: [{ type: 'text', text: 'contents' }],
      status: 'finished',
      isError: false,
    });
    await provider.stop(binding);
  });

  it('keeps two native runtime contexts isolated', async () => {
    const first = fakeClient();
    const second = fakeClient();
    const provider = new PiClientRuntimeProvider(undefined, {
      clientFactory: async (socketPath) =>
        (socketPath.endsWith('/one.sock')
          ? first.client
          : second.client) as never,
    });
    const firstBinding = await provider.start(
      input({ runtimeId: 'runtime-one', socketPath: '/tmp/one.sock' }),
    );
    const secondBinding = await provider.start(
      input({ runtimeId: 'runtime-two', socketPath: '/tmp/two.sock' }),
    );

    await provider.send(firstBinding, { type: 'prompt', text: 'first' });
    await provider.send(secondBinding, { type: 'prompt', text: 'second' });
    expect(first.lease.prompt).toHaveBeenCalledWith('first');
    expect(first.lease.prompt).not.toHaveBeenCalledWith('second');
    expect(second.lease.prompt).toHaveBeenCalledWith('second');
    expect(second.lease.prompt).not.toHaveBeenCalledWith('first');
    await provider.close();
  });

  it('disposes the lease and leaves the registry offline on native disconnect', async () => {
    const fake = fakeClient();
    const registry = new RuntimeRegistry({ expectedToken: () => true });
    await new PiClientRuntimeProvider(registry, {
      clientFactory: async () => fake.client as never,
    }).start(input());

    fake.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(registry.isOnline('runtime-pi-1')).toBe(false);
    expect(fake.lease.dispose).toHaveBeenCalledOnce();
    expect(fake.client.dispose).toHaveBeenCalledOnce();
    registry.close();
  });
});
