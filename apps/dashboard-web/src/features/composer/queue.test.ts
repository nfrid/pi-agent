import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { createElement, type ReactNode } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  mergeQueuedMessages,
  queueCommand,
  queuedMessagesForRuntime,
  queueRemoveCommand,
  shouldShowQueuePanel,
  upsertQueuedMessage,
  useComposerQueue,
} from './queue';

type QueueControls = ReturnType<typeof useComposerQueue>;

function runtimeWithQueue(
  queueDrafts: RuntimeSnapshot['queueDrafts'],
): RuntimeSnapshot {
  return {
    runtimeId: 'runtime-1',
    ownership: 'external',
    pid: 1,
    cwd: '/tmp',
    liveState: 'working',
    online: true,
    pendingInteractions: [],
    session: { id: 'session-1', entries: [] },
    queueDrafts,
  } as RuntimeSnapshot;
}

function QueueProbe({
  runtime,
  onRender,
}: {
  runtime: RuntimeSnapshot;
  onRender: (controls: QueueControls) => void;
}): ReactNode {
  onRender(useComposerQueue(runtime));
  return null;
}

describe('composer queue model', () => {
  it('normalizes malformed and duplicate server drafts', () => {
    expect(
      queuedMessagesForRuntime({
        queueDrafts: [
          { clientId: 'q1', mode: 'steer', text: 'inspect this' },
          { clientId: 'q1', mode: 'steer', text: 'duplicate' },
          { clientId: '', mode: 'steer', text: 'ignore' },
          { clientId: 'q2', mode: 'followUp', text: 'then test it' },
        ],
      } as unknown as RuntimeSnapshot),
    ).toEqual([
      { id: 'q1', mode: 'steer', text: 'inspect this' },
      { id: 'q2', mode: 'followUp', text: 'then test it' },
    ]);
  });

  it('reconciles either command/event ordering without duplicate rows', () => {
    const item = { id: 'q1', mode: 'steer' as const, text: 'inspect this' };
    expect(mergeQueuedMessages([], [item])).toEqual([item]);
    expect(mergeQueuedMessages([item], [item])).toEqual([item]);
    expect(
      mergeQueuedMessages(
        [{ id: 'q1', mode: 'steer', text: 'server text' }],
        [item, { id: 'q2', mode: 'followUp', text: 'then test it' }],
      ),
    ).toEqual([
      { id: 'q1', mode: 'steer', text: 'server text' },
      { id: 'q2', mode: 'followUp', text: 'then test it' },
    ]);
  });

  it('keeps optimistic rows across deferred command and runtime event races', async () => {
    const item = { id: 'q1', mode: 'steer' as const, text: 'inspect this' };
    let controls!: QueueControls;
    const element = (runtime: RuntimeSnapshot) =>
      createElement(QueueProbe, {
        runtime,
        onRender: (next) => {
          controls = next;
        },
      });
    const render = (runtime: RuntimeSnapshot) => {
      let renderer!: ReturnType<typeof create>;
      act(() => {
        renderer = create(element(runtime));
      });
      return renderer;
    };
    const update = (
      renderer: ReturnType<typeof create>,
      runtime: RuntimeSnapshot,
    ) => {
      act(() => renderer.update(element(runtime)));
    };

    // This stands in for Composer's queue.add mutateAsync. The composer calls
    // addOptimistic immediately before awaiting it.
    let resolveCommand!: () => void;
    let commandResolved = false;
    const mutateAsync = new Promise<void>((resolve) => {
      resolveCommand = () => {
        commandResolved = true;
        resolve();
      };
    });
    const queueAdd = () => {
      controls.addOptimistic(item);
      return mutateAsync;
    };
    let renderer = render(runtimeWithQueue([]));
    act(() => {
      void queueAdd();
    });
    expect(commandResolved).toBe(false);
    expect(controls.queue).toEqual([item]);

    // Event-first: the authoritative row replaces the pending row by ID.
    update(
      renderer,
      runtimeWithQueue([
        { clientId: item.id, mode: item.mode, text: item.text },
      ]),
    );
    expect(controls.queue).toEqual([item]);
    act(resolveCommand);
    await mutateAsync;
    expect(controls.queue).toEqual([item]);

    // Once observed, an authoritative removal is allowed to remove it.
    update(renderer, runtimeWithQueue([]));
    expect(controls.queue).toEqual([]);
    renderer.unmount();

    // Response-first: stale state retains the optimistic row, then the
    // authoritative event confirms it without producing a duplicate.
    let resolveResponse!: () => void;
    let responseResolved = false;
    const response = new Promise<void>((resolve) => {
      resolveResponse = () => {
        responseResolved = true;
        resolve();
      };
    });
    const responseFirstQueueAdd = () => {
      controls.addOptimistic(item);
      return response;
    };
    renderer = render(runtimeWithQueue([]));
    act(() => {
      void responseFirstQueueAdd();
    });
    expect(responseResolved).toBe(false);
    act(resolveResponse);
    await response;
    expect(responseResolved).toBe(true);
    expect(controls.queue).toEqual([item]);
    update(
      renderer,
      runtimeWithQueue([
        { clientId: 'other', mode: 'followUp', text: 'keep this too' },
      ]),
    );
    expect(controls.queue).toEqual([
      { id: 'other', mode: 'followUp', text: 'keep this too' },
      item,
    ]);
    update(
      renderer,
      runtimeWithQueue([
        { clientId: item.id, mode: item.mode, text: item.text },
      ]),
    );
    expect(controls.queue).toEqual([item]);
    update(renderer, runtimeWithQueue([]));
    expect(controls.queue).toEqual([]);
    renderer.unmount();
  });

  it('rolls back only an unconfirmed optimistic row on command failure', async () => {
    const existing = {
      id: 'existing',
      mode: 'followUp' as const,
      text: 'already confirmed',
    };
    const item = { id: 'q1', mode: 'steer' as const, text: 'inspect this' };
    let controls!: QueueControls;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        createElement(QueueProbe, {
          runtime: runtimeWithQueue([
            {
              clientId: existing.id,
              mode: existing.mode,
              text: existing.text,
            },
          ]),
          onRender: (next) => {
            controls = next;
          },
        }),
      );
    });
    let rejectCommand!: () => void;
    const failedCommand = new Promise<void>((_, reject) => {
      rejectCommand = () => reject(new Error('queue failed'));
    });
    act(() => {
      controls.addOptimistic(item);
      void failedCommand.catch(() => controls.rejectOptimistic(item.id));
    });
    expect(controls.queue).toEqual([existing, item]);
    act(rejectCommand);
    await act(async () => {
      await failedCommand.catch(() => undefined);
    });
    expect(controls.queue).toEqual([existing]);
    renderer.unmount();
  });

  it('creates bridge commands and preserves optimistic queue identity', () => {
    expect(queueCommand('queue.update', 'q1', 'steer', ' revised ')).toEqual(
      expect.objectContaining({
        type: 'queue.update',
        clientId: 'q1',
        mode: 'steer',
        text: 'revised',
      }),
    );
    expect(queueRemoveCommand('q1')).toEqual(
      expect.objectContaining({ type: 'queue.remove', clientId: 'q1' }),
    );
    const items = [{ id: 'q1', mode: 'steer' as const, text: 'old' }];
    expect(
      upsertQueuedMessage(items, { id: 'q1', mode: 'steer', text: 'new' }),
    ).toEqual([{ id: 'q1', mode: 'steer', text: 'new' }]);
    expect(shouldShowQueuePanel('working', 0)).toBe(true);
    expect(shouldShowQueuePanel('idle', 0)).toBe(false);
  });
});
