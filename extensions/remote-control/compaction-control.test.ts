import { afterEach, describe, expect, it } from 'vitest';
import {
  beginCancellableCompaction,
  cancelActiveCompaction,
} from './compaction-control';

let active: ReturnType<typeof beginCancellableCompaction> | undefined;
afterEach(() => active?.finish());

describe('remote compaction cancellation', () => {
  it('aborts the extension-owned compaction signal directly', () => {
    active = beginCancellableCompaction(new AbortController().signal);

    cancelActiveCompaction();

    expect(active.signal.aborted).toBe(true);
    expect(active.wasCancelled()).toBe(true);
    expect(() => cancelActiveCompaction()).toThrow(
      'There is no active context compaction to cancel.',
    );
  });

  it('also follows cancellation from Pi', () => {
    const parent = new AbortController();
    active = beginCancellableCompaction(parent.signal);

    parent.abort();

    expect(active.signal.aborted).toBe(true);
    expect(active.wasCancelled()).toBe(false);
  });
});
