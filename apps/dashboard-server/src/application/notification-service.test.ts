import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { MetadataStore } from '../metadata.js';
import type { PushSender } from '../push.js';
import type { RegistryChange } from '../runtime-registry.js';
import { NotificationService } from './notification-service.js';

const snapshot: RuntimeSnapshot = {
  runtimeId: 'runtime-replaced',
  ownership: 'external',
  pid: 1,
  cwd: '/tmp/project',
  liveState: 'idle',
  session: { id: 'session-replaced', entries: [] },
  pendingInteractions: [],
};

function goodbye(reason: string): RegistryChange {
  return {
    kind: 'event',
    runtimeId: snapshot.runtimeId,
    event: { type: 'runtime.goodbye', reason },
    snapshot,
  };
}

describe('NotificationService runtime shutdowns', () => {
  it.each([
    'new',
    'resume',
    'fork',
  ])('does not notify for a %s session replacement', (reason) => {
    const addNotification = vi.fn();
    const notify = vi.fn(async () => undefined);
    const service = new NotificationService(
      { addNotification } as unknown as MetadataStore,
      { notify } as unknown as PushSender,
    );

    service.handle(goodbye(reason));

    expect(addNotification).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(['quit', 'reload'])('keeps notifying for %s', (reason) => {
    const addNotification = vi.fn();
    const notify = vi.fn(async () => undefined);
    const service = new NotificationService(
      { addNotification } as unknown as MetadataStore,
      { notify } as unknown as PushSender,
    );

    service.handle(goodbye(reason));

    expect(addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'runtime-exited',
        runtimeId: snapshot.runtimeId,
        sessionId: snapshot.session.id,
      }),
    );
    expect(notify).toHaveBeenCalledWith(addNotification.mock.calls[0][0]);
  });
});
