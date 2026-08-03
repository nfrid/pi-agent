import { describe, expect, it } from 'vitest';
import {
  asBrowserSnapshot,
  asSessionResponse,
  nextReconnectDelay,
  reconnectDelayWithJitter,
  shouldAcceptRevision,
} from './dashboard-transport';

describe('dashboard transport revisions', () => {
  it('rejects snapshots older than the browser cursor', () => {
    expect(shouldAcceptRevision(7, 6)).toBe(false);
    expect(shouldAcceptRevision(7, 7)).toBe(true);
    expect(shouldAcceptRevision(7, 8)).toBe(true);
  });

  it('preserves the server generation used to reset revisions after restart', () => {
    expect(
      asBrowserSnapshot({
        serverId: 'daemon-2',
        revision: 0,
        runtimes: [],
        workspaces: [],
        sessions: [],
      })?.serverId,
    ).toBe('daemon-2');
  });

  it('rejects malformed nested state before it can reach React', () => {
    expect(
      asBrowserSnapshot({
        serverId: 'daemon',
        revision: 1,
        runtimes: [{}],
        workspaces: [],
        sessions: [],
        unread: [],
      }),
    ).toBeUndefined();
    expect(
      asBrowserSnapshot({
        serverId: 'daemon',
        revision: Number.NaN,
        runtimes: [],
        workspaces: [],
        sessions: [],
        unread: [],
      }),
    ).toBeUndefined();
    expect(
      asSessionResponse({
        metadata: { id: 'session', cwd: '/tmp', name: {} },
        entries: [],
      }),
    ).toBeUndefined();
  });

  it('caps exponential reconnect delay and applies bounded jitter', () => {
    expect(nextReconnectDelay(500)).toBe(1_000);
    expect(nextReconnectDelay(20_000)).toBe(30_000);
    expect(reconnectDelayWithJitter(1_000, () => 0)).toBe(800);
    expect(reconnectDelayWithJitter(1_000, () => 1)).toBe(1_200);
  });
});
