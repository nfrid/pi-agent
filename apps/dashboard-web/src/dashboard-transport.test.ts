import { describe, expect, it } from 'vitest';
import { shouldAcceptRevision } from './dashboard-transport';

describe('dashboard transport revisions', () => {
  it('rejects snapshots older than the browser cursor', () => {
    expect(shouldAcceptRevision(7, 6)).toBe(false);
    expect(shouldAcceptRevision(7, 7)).toBe(true);
    expect(shouldAcceptRevision(7, 8)).toBe(true);
  });
});
