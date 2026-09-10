import type { SessionIndexEntry } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import { sessionRelationships } from './views';

const parent: SessionIndexEntry = {
  id: 'parent',
  file: '/tmp/parent.jsonl',
  cwd: '/tmp',
  updatedAt: 1,
};
const child: SessionIndexEntry = {
  id: 'child',
  file: '',
  cwd: '/tmp',
  updatedAt: 2,
  sessionKind: 'delegate',
  parentSessionId: 'parent',
};
const sessions = [parent, child];

describe('session relationships', () => {
  it('resolves both parent and child navigation', () => {
    expect(sessionRelationships('parent', parent, sessions)).toEqual({
      children: [child],
    });
    expect(sessionRelationships('child', child, sessions)).toEqual({
      parent,
      children: [],
    });
  });
});
