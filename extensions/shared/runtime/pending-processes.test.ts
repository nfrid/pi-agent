import { describe, expect, it } from 'vitest';
import {
  hasPendingProcesses,
  pendingProcessCount,
  setPendingProcessCount,
} from './pending-processes';

describe('pending process aggregate', () => {
  it('combines manager counts and removes zero-valued sources', () => {
    const first = {};
    const second = {};
    const baseline = pendingProcessCount();

    setPendingProcessCount(first, 2);
    setPendingProcessCount(second, 1);
    expect(pendingProcessCount()).toBe(baseline + 3);
    expect(hasPendingProcesses()).toBe(true);

    setPendingProcessCount(first, 1);
    setPendingProcessCount(second, 0);
    expect(pendingProcessCount()).toBe(baseline + 1);

    setPendingProcessCount(first, 0);
    expect(pendingProcessCount()).toBe(baseline);
  });
});
