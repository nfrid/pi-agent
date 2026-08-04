import { describe, expect, it } from 'vitest';
import { DashboardEventStream } from './event-stream.js';

describe('dashboard event stream', () => {
  it('allocates daemon-global cursors and bounds replay', () => {
    const stream = new DashboardEventStream(2);
    const seen: number[] = [];
    stream.subscribe((record) => seen.push(record.cursor));
    stream.publish((cursor, emittedAt) => ({
      cursor,
      emittedAt,
      type: 'snapshot',
      snapshot: {} as never,
    }));
    stream.publish((cursor, emittedAt) => ({
      cursor,
      emittedAt,
      type: 'snapshot',
      snapshot: {} as never,
    }));
    stream.publish((cursor, emittedAt) => ({
      cursor,
      emittedAt,
      type: 'snapshot',
      snapshot: {} as never,
    }));
    expect(stream.cursor).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
    expect(stream.replayAfter(1).events.map((event) => event.cursor)).toEqual([
      2, 3,
    ]);
    expect(stream.replayAfter(0).gap).toBe(true);
    expect(stream.replayAfter(4).gap).toBe(true);
  });

  it('does not report a gap at the replay boundary', () => {
    const stream = new DashboardEventStream(2);
    for (let i = 0; i < 2; i++)
      stream.publish((cursor, emittedAt) => ({
        cursor,
        emittedAt,
        type: 'snapshot',
        snapshot: {} as never,
      }));
    expect(stream.replayAfter(1).gap).toBe(false);
  });
});
