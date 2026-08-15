import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  mergeQueuedMessages,
  queueCommand,
  queuedMessagesForRuntime,
  queueRemoveCommand,
  shouldShowQueuePanel,
  upsertQueuedMessage,
} from './queue';

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
