import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_JOBS_MAX_COMMAND_BYTES,
  OutputTail,
  parseBackgroundJobsRequest,
  parseBackgroundJobsResponse,
} from './index.js';

const id = '123e4567-e89b-12d3-a456-426614174000';

describe('background-jobs protocol', () => {
  it('rejects wrong versions and oversized launch facts', () => {
    expect(() =>
      parseBackgroundJobsRequest({ v: 2, op: 'list', ownerSession: 's' }),
    ).toThrow();
    expect(() =>
      parseBackgroundJobsRequest({
        v: 1,
        op: 'start',
        input: {
          id,
          ownerSession: 's',
          command: 'x'.repeat(BACKGROUND_JOBS_MAX_COMMAND_BYTES + 1),
          title: 't',
          cwd: '.',
        },
      }),
    ).toThrow(/oversized command/);
  });

  it('validates bounded snapshots in responses', () => {
    expect(() =>
      parseBackgroundJobsResponse({
        v: 1,
        ok: true,
        job: {
          id,
          ownerSession: 's',
          title: 't',
          command: 'echo ok',
          cwd: '.',
          status: 'done',
          createdAt: 1,
          stdout: { text: '', totalBytes: 0, droppedBytes: 0 },
          stderr: { text: '', totalBytes: 0, droppedBytes: 1 },
        },
      }),
    ).toThrow(/byte counts/);
  });

  it('keeps UTF-8 output tails bounded and counts dropped bytes', () => {
    const tail = new OutputTail(5);
    tail.push('a🙂b🙂c');
    const snapshot = tail.snapshot();
    expect(Buffer.byteLength(snapshot.text)).toBeLessThanOrEqual(5);
    expect(snapshot.totalBytes).toBe(Buffer.byteLength('a🙂b🙂c'));
    expect(snapshot.droppedBytes + Buffer.byteLength(snapshot.text)).toBe(
      snapshot.totalBytes,
    );
  });
});
