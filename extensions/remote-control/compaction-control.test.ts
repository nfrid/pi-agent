import { afterEach, describe, expect, it } from 'vitest';
import {
  cancelActiveCompaction,
  clearActiveCompaction,
  trackActiveCompaction,
} from './compaction-control';

afterEach(() => clearActiveCompaction());

describe('remote compaction cancellation', () => {
  it('waits for buffered TUI Escape handling before accepting cancellation', async () => {
    const controller = new AbortController();
    trackActiveCompaction(controller.signal);

    await cancelActiveCompaction(
      () => setTimeout(() => controller.abort(), 15),
      100,
    );

    expect(controller.signal.aborted).toBe(true);
    await expect(cancelActiveCompaction()).rejects.toThrow(
      'There is no active context compaction to cancel.',
    );
  });

  it('rejects when the Pi mode does not turn Escape into compaction abort', async () => {
    const controller = new AbortController();
    trackActiveCompaction(controller.signal);

    await expect(cancelActiveCompaction(() => undefined, 5)).rejects.toThrow(
      'This Pi mode does not expose context compaction cancellation.',
    );
    expect(controller.signal.aborted).toBe(false);
  });
});
