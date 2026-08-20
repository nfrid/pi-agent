import { describe, expect, it } from 'vitest';
import type { AgentThreadRow } from './model';
import {
  isThreadUnread,
  markThreadUnread,
  type ThreadReadState,
  visitThread,
} from './read-state';

const row = (updatedAt?: number): Pick<AgentThreadRow, 'id' | 'updatedAt'> => ({
  id: 'thread-1',
  updatedAt,
});

describe('agent thread unread state', () => {
  it('does not treat a never-visited session as unread', () => {
    expect(isThreadUnread(row(20), {})).toBe(false);
  });

  it('becomes unread only after an update newer than the visit', () => {
    const visited = visitThread({}, 'thread-1', 20);
    expect(isThreadUnread(row(20), visited)).toBe(false);
    expect(isThreadUnread(row(21), visited)).toBe(true);
  });

  it('supports explicitly marking a thread unread', () => {
    const state: ThreadReadState = markThreadUnread(
      visitThread({}, 'thread-1', 20),
      'thread-1',
    );
    expect(isThreadUnread(row(20), state)).toBe(true);
  });

  it('treats a later indexed update as unread after an unindexed visit', () => {
    const state = visitThread({}, 'thread-1');
    expect(isThreadUnread(row(undefined), state)).toBe(false);
    expect(isThreadUnread(row(20), state)).toBe(true);
  });
});
