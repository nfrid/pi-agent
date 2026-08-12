import { describe, expect, it } from 'vitest';
import { isContiguousOlderHistory } from './history';

const current = {
  version: 1 as const,
  start: 20,
  end: 40,
  hasOlder: true,
  nextBefore: 'cursor-20',
};

describe('isContiguousOlderHistory', () => {
  it('accepts a contiguous page and advances its cursor', () => {
    expect(
      isContiguousOlderHistory(
        'session-1',
        'session-1',
        {
          version: 1,
          start: 0,
          end: 20,
          hasOlder: true,
          nextBefore: 'cursor-0',
        },
        current,
        current.nextBefore,
      ),
    ).toBe(true);
  });

  it('rejects pages that do not precede the range or repeat the cursor', () => {
    for (const page of [
      { version: 1 as const, start: 20, end: 20, hasOlder: false },
      {
        version: 1 as const,
        start: 0,
        end: 19,
        hasOlder: false,
      },
      {
        version: 1 as const,
        start: 0,
        end: 20,
        hasOlder: true,
        nextBefore: current.nextBefore,
      },
    ]) {
      expect(
        isContiguousOlderHistory(
          'session-1',
          'session-1',
          page,
          current,
          current.nextBefore,
        ),
      ).toBe(false);
    }
  });

  it('rejects a page for a different session', () => {
    expect(
      isContiguousOlderHistory(
        'session-1',
        'session-2',
        {
          version: 1,
          start: 0,
          end: 20,
          hasOlder: false,
        },
        current,
        current.nextBefore,
      ),
    ).toBe(false);
  });
});
