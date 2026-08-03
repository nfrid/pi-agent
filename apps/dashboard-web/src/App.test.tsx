import { describe, expect, it } from 'vitest';
import { asBrowserSnapshot, asSessionResponse, contextIndicatorData, formatContextTokens, reconcileLiveEvent, toTranscriptEntries } from './App';

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

describe('context window indicator', () => {
  it('matches the compact TUI token format and warning thresholds', () => {
    expect(formatContextTokens(950)).toBe('950');
    expect(formatContextTokens(12_400)).toBe('12.4k');
    expect(formatContextTokens(1_050_000)).toBe('1.1m');
    expect(contextIndicatorData({ tokens: 136_000, contextWindow: 272_000, percent: 50 })).toEqual({ percent: 50, text: '50% [136k/272k]', level: 'warning' });
    expect(contextIndicatorData({ tokens: 230_000, contextWindow: 272_000, percent: 84.56 })).toEqual({ percent: 85, text: '85% [230k/272k]', level: 'error' });
    expect(contextIndicatorData({ tokens: null, contextWindow: 272_000, percent: null })).toEqual({ percent: undefined, text: '?% [?/272k]', level: 'normal' });
  });
});

describe('active transcript reconciliation', () => {
  it('reconciles representative ID-less streaming assistant messages in place', () => {
    const entries = [{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'start' }] } }];
    const event = { type: 'message.updated', sessionId: 's1', message: { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } };
    const updated = reconcileLiveEvent(entries, event, 's1');
    expect(updated).toHaveLength(1);
    expect(JSON.stringify(updated)).toContain('done');
  });

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

  it('pairs persisted Pi tool results with calls and excludes result-only rows', () => {
    const callId = 'call-1';
    const entries = toTranscriptEntries([
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'read', arguments: { path: 'a.ts' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: callId, toolName: 'read', content: [{ type: 'text', text: 'file' }], isError: false } },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.entry).toMatchObject({ kind: 'assistant' });
    expect(entries[1]?.entry).toMatchObject({ kind: 'tool', name: 'read' });
    expect(JSON.stringify(entries[1]?.raw)).toContain('"result"');
  });

  it('ignores events from the previous session', () => {
    const entries = [{ type: 'message', message: { id: 'm1' } }];
    expect(reconcileLiveEvent(entries, { type: 'message.updated', sessionId: 'old', message: { id: 'old' } }, 'new')).toEqual(entries);
  });
});
