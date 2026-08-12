import { afterEach, describe, expect, it } from 'vitest';
import {
  cancelActiveCompaction,
  clearActiveCompaction,
  trackActiveCompaction,
} from './compaction-control';

afterEach(() => clearActiveCompaction());

describe('remote compaction cancellation', () => {
  it('cancels only the currently tracked compaction', () => {
    const controller = new AbortController();
    trackActiveCompaction(controller.signal);

    cancelActiveCompaction(() => controller.abort());

    expect(controller.signal.aborted).toBe(true);
    expect(() => cancelActiveCompaction()).toThrow(
      'There is no active context compaction to cancel.',
    );
  });

  it('rejects when the Pi mode does not turn Escape into compaction abort', () => {
    const controller = new AbortController();
    trackActiveCompaction(controller.signal);

    expect(() => cancelActiveCompaction(() => undefined)).toThrow(
      'This Pi mode does not expose context compaction cancellation.',
    );
    expect(controller.signal.aborted).toBe(false);
  });
});
