import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllNativeSteeringControllers,
  registerNativeSteeringController,
} from '../shared/runtime/native-steering';
import {
  NATIVE_STEERING_CAPABILITY_ID,
  nativeSteeringContribution,
  QUEUE_STEER_NOW_ACTION_ID,
} from './native-steering';
import { QueueDraftStore } from './queue-draft-store';

afterEach(() => clearAllNativeSteeringControllers('test cleanup'));

function hostFor(id: string) {
  const store = new QueueDraftStore();
  store.setSession(id);
  let leafId = 'leaf-a';
  let activeSessionId = id;
  const ctx = {
    isIdle: () => false,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => activeSessionId,
      getLeafId: () => leafId,
      getBranch: () => [{ id: leafId }],
    },
  } as unknown as ExtensionContext;
  const host = {
    getContext: () => ctx,
    pi: {
      getCommands: () => [],
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI,
    store,
    isCurrent: (candidate: ExtensionContext) =>
      candidate === ctx && candidate.sessionManager.getSessionId() === id,
    publish: vi.fn(),
  };
  return {
    store,
    ctx,
    host,
    replaceBranch: () => {
      leafId = 'leaf-b';
    },
    replaceSession: () => {
      activeSessionId = 'replacement-session';
    },
  };
}

function invoke(host: ReturnType<typeof hostFor>['host'], input: unknown) {
  const handler =
    nativeSteeringContribution(host).actionHandlers?.[
      QUEUE_STEER_NOW_ACTION_ID
    ];
  if (!handler) throw new Error('native action handler missing');
  return handler(
    { actionId: QUEUE_STEER_NOW_ACTION_ID, input } as never,
    {} as never,
  );
}

describe('native queue steering contribution', () => {
  it('advertises live controller availability per session scope', () => {
    const first = hostFor('session-first');
    const second = hostFor('session-second');
    const controller = {
      isAvailable: () => true,
      steer: vi.fn(),
      close: vi.fn(),
    };
    registerNativeSteeringController('session-first', controller);

    expect(
      nativeSteeringContribution(first.host).snapshotProvider?.()?.[0],
    ).toMatchObject({ id: NATIVE_STEERING_CAPABILITY_ID, available: true });
    expect(
      nativeSteeringContribution(second.host).snapshotProvider?.()?.[0],
    ).toMatchObject({ id: NATIVE_STEERING_CAPABILITY_ID, available: false });
  });

  it('retains an uncertain claim when the source branch changes after native acceptance', async () => {
    const { store, host, replaceBranch } = hostFor('session-branch-change');
    store.add({ clientId: 'draft-branch', mode: 'steer', text: 'steer text' });
    registerNativeSteeringController('session-branch-change', {
      isAvailable: () => true,
      steer: async (_text, onAccepted) => {
        replaceBranch();
        try {
          await onAccepted();
          return { status: 'accepted', steerId: 'accepted' };
        } catch (error) {
          return {
            status: 'unknown',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
      close: () => undefined,
    });

    await expect(
      invoke(host, {
        clientId: 'draft-branch',
        revision: 1,
        expectedSessionId: 'session-branch-change',
      }),
    ).resolves.toMatchObject({ accepted: false, status: 'unknown' });
    expect(store.listHandoffs()).toMatchObject([
      { clientId: 'draft-branch', status: 'uncertain' },
    ]);
    expect(store.list()).toMatchObject([{ clientId: 'draft-branch' }]);
  });

  it('blocks the acceptance callback after its runtime binding is replaced', async () => {
    const { store, host, replaceSession } = hostFor('session-binding-replaced');
    store.add({ clientId: 'draft-stale', mode: 'steer', text: 'steer text' });
    registerNativeSteeringController('session-binding-replaced', {
      isAvailable: () => true,
      steer: async (_text, onAccepted) => {
        replaceSession();
        try {
          await onAccepted();
          return { status: 'accepted', steerId: 'should-not-admit' };
        } catch (error) {
          return {
            status: 'unknown',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
      close: () => undefined,
    });

    await expect(
      invoke(host, {
        clientId: 'draft-stale',
        revision: 1,
        expectedSessionId: 'session-binding-replaced',
      }),
    ).resolves.toMatchObject({ accepted: false, status: 'unknown' });
    expect(host.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(store.listHandoffs()).toMatchObject([
      { clientId: 'draft-stale', status: 'handing-off' },
    ]);
  });

  it('settles known native rejection as editable and preserves stale source checks', async () => {
    const { store, host } = hostFor('session-reject');
    store.add({ clientId: 'draft-a', mode: 'steer', text: 'steer text' });
    registerNativeSteeringController('session-reject', {
      isAvailable: () => true,
      steer: async () => ({
        status: 'failed',
        message: 'server rejected steer',
      }),
      close: () => undefined,
    });

    await expect(
      invoke(host, {
        clientId: 'draft-a',
        revision: 1,
        expectedSessionId: 'other-session',
      }),
    ).rejects.toMatchObject({ code: 'unavailable-action' });
    expect(store.list()).toHaveLength(1);

    await expect(
      invoke(host, {
        clientId: 'draft-a',
        revision: 1,
        expectedSessionId: 'session-reject',
      }),
    ).resolves.toMatchObject({ accepted: false, status: 'failed' });
    expect(store.list()).toMatchObject([{ clientId: 'draft-a' }]);
    expect(store.listHandoffs()).toMatchObject([
      { clientId: 'draft-a', status: 'failed' },
    ]);
  });
});
