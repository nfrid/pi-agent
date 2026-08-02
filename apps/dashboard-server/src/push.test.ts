import { describe, expect, it } from 'vitest';
import { notificationTopic } from './push.js';

describe('push topics', () => {
  it('uses stable topics no longer than the Web Push 32-byte limit', () => {
    const runtime = `runtime-${'x'.repeat(200)}`;
    const first = notificationTopic('waiting', runtime, 'interaction-1');
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(32);
    expect(first).toBe(notificationTopic('waiting', runtime, 'interaction-2'));
    expect(notificationTopic('failed', runtime, 'failure')).not.toBe(first);
  });
});
