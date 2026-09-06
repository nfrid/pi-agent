import type {
  ContextEvent,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import midRunCompaction from './index.js';

function contextHandler() {
  const on = vi.fn();
  midRunCompaction({ on } as unknown as ExtensionAPI);
  expect(on).toHaveBeenCalledOnce();
  expect(on.mock.calls[0]?.[0]).toBe('context');
  return on.mock.calls[0]?.[1] as (
    event: ContextEvent,
  ) => { messages: ContextEvent['messages'] } | undefined;
}

const userMessage: ContextEvent['messages'][number] = {
  role: 'user',
  content: 'Continue the task.',
  timestamp: 1,
};
const continuationMarker: ContextEvent['messages'][number] = {
  role: 'custom',
  customType: 'pi-mid-run-compaction-continue',
  content: [],
  display: false,
  timestamp: 2,
};

// Pi 0.85.1 owns between-turn compaction. This extension no longer loads or
// patches private SDK methods; its only responsibility is persisted markers.
describe('legacy mid-run compaction context cleanup', () => {
  it('removes only the old continuation markers without mutating history', () => {
    const otherCustom = {
      ...continuationMarker,
      customType: 'other-extension',
    };
    const messages = [userMessage, continuationMarker, otherCustom];
    const result = contextHandler()({ type: 'context', messages });

    expect(result?.messages).toEqual([userMessage, otherCustom]);
    expect(messages).toEqual([userMessage, continuationMarker, otherCustom]);
  });

  it('leaves ordinary contexts unchanged', () => {
    expect(
      contextHandler()({ type: 'context', messages: [userMessage] }),
    ).toBeUndefined();
  });
});
