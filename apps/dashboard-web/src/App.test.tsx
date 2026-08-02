import { describe, expect, it } from 'vitest';
import { asBrowserSnapshot, asSessionResponse, reconcileLiveEvent } from './App';

describe('dashboard snapshots', () => {
  it('rejects malformed session responses before rendering', () => {
    expect(asSessionResponse({ entries: [] })).toBeUndefined();
    expect(asSessionResponse({ metadata: { id: 's1', cwd: '/tmp' }, entries: [] })).toMatchObject({ metadata: { id: 's1' } });
  });

  it('rejects runtime snapshots and defaults optional browser collections', () => {
    expect(asBrowserSnapshot({ runtimeId: 'runtime-1' })).toBeUndefined();
    expect(asBrowserSnapshot({ revision: 1, runtimes: [], workspaces: [], sessions: [] })).toMatchObject({ unread: [] });
  });
});

describe('active transcript reconciliation', () => {
  it('updates a live item by stable id without appending duplicates', () => {
    const entries = [{ type: 'message', message: { id: 'm1', role: 'assistant', content: [] } }];
    const event = { type: 'message.updated', sessionId: 's1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
    const once = reconcileLiveEvent(entries, event, 's1');
    const twice = reconcileLiveEvent(once, { ...event, message: { ...event.message, content: [{ type: 'text', text: 'done!' }] } }, 's1');
    expect(twice).toHaveLength(1);
    expect(JSON.stringify(twice)).toContain('done!');
  });

  it('keeps live tools renderable when updating nested and new calls', () => {
    const entries = [{ type: 'message', message: { id: 'm1', role: 'assistant', content: [{ type: 'toolCall', toolCallId: 't1', name: 'read' }] } }];
    const updated = reconcileLiveEvent(entries, { type: 'tool.updated', sessionId: 's1', tool: { toolCallId: 't1', toolName: 'read', args: { path: 'a.ts' } } }, 's1');
    expect(JSON.stringify(updated)).toContain('"type":"toolCall"');
    expect(JSON.stringify(updated)).toContain('"name":"read"');
    const appended = reconcileLiveEvent(updated, { type: 'tool.started', sessionId: 's1', tool: { toolCallId: 't2', toolName: 'bash', args: { command: 'pwd' } } }, 's1');
    expect(appended).toHaveLength(2);
    expect(JSON.stringify(appended[1])).toContain('"name":"bash"');
    const finished = reconcileLiveEvent(appended, { type: 'tool.finished', sessionId: 's1', tool: { toolCallId: 't2', toolName: 'bash', result: 'ok' } }, 's1');
    expect(finished).toHaveLength(2);
    expect(finished[1]).toMatchObject({ type: 'tool', tool: { name: 'bash', result: 'ok' } });
  });

  it('ignores events from the previous session', () => {
    const entries = [{ type: 'message', message: { id: 'm1' } }];
    expect(reconcileLiveEvent(entries, { type: 'message.updated', sessionId: 'old', message: { id: 'old' } }, 'new')).toEqual(entries);
  });
});
