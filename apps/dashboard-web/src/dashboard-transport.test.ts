import { describe, expect, it } from 'vitest';
import { asBrowserSnapshot, shouldAcceptRevision } from './dashboard-transport';

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
});
