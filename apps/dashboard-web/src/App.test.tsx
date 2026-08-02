import { describe, expect, it } from 'vitest';
import { reconcileLiveEvent } from './App';

describe('active transcript reconciliation', () => {
  it('updates a live item by stable id without appending duplicates', () => {
    const entries = [{ type: 'message', message: { id: 'm1', role: 'assistant', content: [] } }];
    const event = { type: 'message.updated', sessionId: 's1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
    const once = reconcileLiveEvent(entries, event, 's1');
    const twice = reconcileLiveEvent(once, { ...event, message: { ...event.message, content: [{ type: 'text', text: 'done!' }] } }, 's1');
    expect(twice).toHaveLength(1);
    expect(JSON.stringify(twice)).toContain('done!');
  });

  it('ignores events from the previous session', () => {
    const entries = [{ type: 'message', message: { id: 'm1' } }];
    expect(reconcileLiveEvent(entries, { type: 'message.updated', sessionId: 'old', message: { id: 'old' } }, 'new')).toEqual(entries);
  });
});
