import { afterEach, describe, expect, test } from 'vitest';
import {
  beginsFreshUserTurn,
  isGenuineAgentSettlement,
} from './agent-lifecycle';
import { setPendingProcessCount } from './pending-processes';

const source = {};

afterEach(() => setPendingProcessCount(source, 0));

describe('shared agent lifecycle policy', () => {
  test('recognizes settlement only after shared and caller-local work ends', () => {
    expect(isGenuineAgentSettlement()).toBe(true);
    expect(isGenuineAgentSettlement(true)).toBe(false);

    setPendingProcessCount(source, 1);
    expect(isGenuineAgentSettlement()).toBe(false);
  });

  test('recognizes only a fresh idle user turn', () => {
    expect(beginsFreshUserTurn({ source: 'interactive' })).toBe(true);
    expect(beginsFreshUserTurn({ source: 'rpc' })).toBe(true);
    expect(beginsFreshUserTurn({ source: 'extension' })).toBe(false);
    expect(
      beginsFreshUserTurn({
        source: 'interactive',
        streamingBehavior: 'steer',
      }),
    ).toBe(false);
    expect(
      beginsFreshUserTurn({
        source: 'interactive',
        streamingBehavior: 'followUp',
      }),
    ).toBe(false);

    setPendingProcessCount(source, 1);
    expect(beginsFreshUserTurn({ source: 'interactive' })).toBe(false);
  });
});
