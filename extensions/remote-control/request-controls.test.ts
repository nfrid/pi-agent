import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import { aggregateRuntimeCapabilities } from '../shared/runtime/capability-registry';
import { getLiveExtensionSurfaceHub } from '../shared/runtime/live-surfaces';
import { getScopedServices } from '../shared/runtime/scoped-services';
import type { BridgeClientOptions } from './bridge-client';
import { publishSettledBackground } from './live';
import { QueueDraftStore } from './queue-draft-store';
import {
  createRemoteControlRuntime,
  flushQueueDrafts,
  type RemoteControlRuntime,
} from './runtime';

it('keeps dashboard follow-ups editable until required outcomes enter the request', () => {
  const scope = `request-controls-${Math.random()}`;
  const services = getScopedServices(scope);
  let pending = true;
  services.requestDependencies = {
    register: () => true,
    resolveDelegateGate: () => {},
    hasPending: () => pending,
  };
  const ctx = {
    sessionManager: { getSessionId: () => scope },
  } as unknown as ExtensionContext;
  const drafts = new QueueDraftStore();
  drafts.setSession(scope);
  drafts.add({
    type: 'queue.add',
    clientId: 'later-1',
    mode: 'followUp',
    text: 'Next request',
  });
  const sendUserMessage = vi.fn();
  const pi = {
    sendUserMessage,
    getCommands: () => [],
  } as unknown as ExtensionAPI;
  const runtime = {
    isCurrent: () => true,
    setContext: vi.fn(),
    client: { sendEvent: vi.fn() },
    queueDrafts: drafts,
  } as unknown as RemoteControlRuntime;
  try {
    expect(flushQueueDrafts(runtime, pi, ctx, 'followUp')).toBe(false);
    expect(drafts.list()).toHaveLength(1);
    expect(sendUserMessage).not.toHaveBeenCalled();
    pending = false;
    // A successful handover refreshes state through the ordinary adapter.
    Object.assign(ctx, { isIdle: () => true });
    expect(flushQueueDrafts(runtime, pi, ctx, 'followUp')).toBe(true);
    expect(sendUserMessage).toHaveBeenCalledWith('Next request', {
      deliverAs: 'followUp',
    });
    expect(drafts.list()).toHaveLength(0);
  } finally {
    services.requestDependencies = undefined;
  }
});

it('refreshes idle abort without a new SDK run or a fabricated handoff', async () => {
  const scope = `idle-abort-${Math.random()}`;
  const services = getScopedServices(scope);
  let pending = true;
  services.requestDependencies = {
    register: () => true,
    resolveDelegateGate: () => {},
    hasPending: () => pending,
    abandon: () => {
      pending = false;
    },
  };
  const ctx = {
    cwd: '/tmp',
    isIdle: () => true,
    abort: vi.fn(),
    getContextUsage: () => undefined,
    sessionManager: {
      getSessionId: () => scope,
      getSessionFile: () => undefined,
      getSessionName: () => undefined,
      getCwd: () => '/tmp',
      getLeafId: () => undefined,
      getBranch: () => [],
    },
  } as unknown as ExtensionContext;
  const runtime = createRemoteControlRuntime({} as ExtensionAPI);
  if (!runtime) throw new Error('Missing runtime');
  try {
    runtime.setContext(ctx);
    publishSettledBackground(0, scope, true);
    const sendEvent = vi.spyOn(runtime.client, 'sendEvent');
    // Exercise the real command callback; no sockets or background hosts start.
    const client = runtime.client as unknown as {
      options: BridgeClientOptions;
    };
    await client.options.handleCommand(
      { id: 'abort-idle', type: 'abort' },
      aggregateRuntimeCapabilities(scope),
    );
    expect(ctx.abort).toHaveBeenCalledOnce();
    expect(pending).toBe(false);
    expect(getLiveExtensionSurfaceHub(scope).snapshot()).toEqual([]);
    expect(runtime.snapshot().liveState).toBe('idle');
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'runtime.stateChanged',
        state: 'idle',
      }),
    );
    expect(
      sendEvent.mock.calls.some(([event]) => event.type === 'agent.settled'),
    ).toBe(false);
  } finally {
    runtime.client.stop();
    runtime.clearContext(ctx);
    services.requestDependencies = undefined;
  }
});
