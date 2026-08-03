import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  addImageAttachments,
  asBrowserSnapshot,
  asSessionResponse,
  contextIndicatorData,
  formatContextTokens,
  isNearPageBottom,
  reconcileLiveEvent,
  runtimeSupportsImages,
  sessionDisplayTitle,
  shouldShowActivityLead,
  toTranscriptEntries,
} from './App';

describe('image attachments', () => {
  const image = (name: string, type: string, size: number) =>
    new File([new Uint8Array(size)], name, { type });

  it('accepts supported images within count and size limits', () => {
    const result = addImageAttachments([], [image('one.png', 'image/png', 4)]);
    expect(result).toEqual({ accepted: [expect.any(File)] });
  });

  it('rejects unsupported, oversized, and over-count attachments', () => {
    expect(
      addImageAttachments([], [image('no.gif', 'image/gif', 1)]).error,
    ).toContain('not a PNG');
    expect(
      addImageAttachments(
        [],
        [image('large.jpg', 'image/jpeg', 5 * 1024 * 1024 + 1)],
      ).error,
    ).toContain('5 MiB');
    const existing = Array.from({ length: 4 }, (_, index) =>
      image(`${index}.webp`, 'image/webp', 1),
    );
    expect(
      addImageAttachments(existing, [image('fifth.webp', 'image/webp', 1)])
        .error,
    ).toContain('up to 4');
  });

  it('keeps image capability compatible when omitted', () => {
    const runtime = {
      model: { provider: 'test', model: 'vision' },
    } as RuntimeSnapshot;
    expect(runtimeSupportsImages(runtime)).toBe(true);
    expect(
      runtimeSupportsImages({
        ...runtime,
        model: { provider: 'test', model: 'vision', supportsImages: false },
      }),
    ).toBe(false);
  });
});

describe('dashboard snapshots', () => {
  it('rejects malformed session responses before rendering', () => {
    expect(asSessionResponse({ entries: [] })).toBeUndefined();
    expect(
      asSessionResponse({ metadata: { id: 's1', cwd: '/tmp' }, entries: [] }),
    ).toMatchObject({ metadata: { id: 's1' } });
  });

  it('rejects runtime snapshots and defaults optional browser collections', () => {
    expect(asBrowserSnapshot({ runtimeId: 'runtime-1' })).toBeUndefined();
    expect(
      asBrowserSnapshot({
        revision: 1,
        runtimes: [],
        workspaces: [],
        sessions: [],
      }),
    ).toMatchObject({ unread: [] });
  });
});

describe('session titles', () => {
  it('prefers custom names, then normalized titles, then a non-UUID fallback', () => {
    expect(sessionDisplayTitle({ name: 'Custom name', title: 'Prompt' })).toBe(
      'Custom name',
    );
    expect(sessionDisplayTitle({ title: 'Prompt' })).toBe('Prompt');
    expect(
      sessionDisplayTitle({}, [
        {
          type: 'message',
          message: { role: 'user', content: '  first   request  ' },
        },
      ]),
    ).toBe('first request');
    expect(sessionDisplayTitle({})).toBe('Untitled session');
  });
});

describe('context window indicator', () => {
  it('matches the compact TUI token format and warning thresholds', () => {
    expect(formatContextTokens(950)).toBe('950');
    expect(formatContextTokens(12_400)).toBe('12.4k');
    expect(formatContextTokens(1_050_000)).toBe('1.1m');
    expect(
      contextIndicatorData({
        tokens: 136_000,
        contextWindow: 272_000,
        percent: 50,
      }),
    ).toEqual({ percent: 50, text: '50% [136k/272k]', level: 'warning' });
    expect(
      contextIndicatorData({
        tokens: 230_000,
        contextWindow: 272_000,
        percent: 84.56,
      }),
    ).toEqual({ percent: 85, text: '85% [230k/272k]', level: 'error' });
    expect(
      contextIndicatorData({
        tokens: null,
        contextWindow: 272_000,
        percent: null,
      }),
    ).toEqual({ percent: undefined, text: '?% [?/272k]', level: 'normal' });
  });
});

describe('activity presentation', () => {
  it('hides an assistant lead when the same text is used as the title', () => {
    expect(
      shouldShowActivityLead(
        'Checking the mobile transcript.',
        'Checking the mobile transcript',
      ),
    ).toBe(false);
    expect(
      shouldShowActivityLead('A useful explanation.', 'Explored with read'),
    ).toBe(true);
  });
});

describe('active transcript reconciliation', () => {
  it('reconciles representative ID-less streaming assistant messages in place', () => {
    const entries = [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'start' }],
        },
      },
    ];
    const event = {
      type: 'message.updated',
      sessionId: 's1',
      message: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      },
    };
    const updated = reconcileLiveEvent(entries, event, 's1');
    expect(updated).toHaveLength(1);
    expect(JSON.stringify(updated)).toContain('done');
  });

  it('reconciles ID-less user start/end events by Pi timestamp', () => {
    const start = {
      type: 'message.started',
      sessionId: 's1',
      message: {
        message: {
          role: 'user',
          timestamp: 123,
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    };
    const finish = { ...start, type: 'message.finished' };
    const once = reconcileLiveEvent([], start, 's1');
    const twice = reconcileLiveEvent(once, finish, 's1');
    expect(twice).toHaveLength(1);
    expect(JSON.stringify(twice)).toContain('hello');
    const repeatedLater = reconcileLiveEvent(
      twice,
      {
        ...start,
        message: {
          message: {
            role: 'user',
            timestamp: 456,
            content: [{ type: 'text', text: 'hello' }],
          },
        },
      },
      's1',
    );
    expect(repeatedLater).toHaveLength(2);
  });

  it('updates a live item by stable id without appending duplicates', () => {
    const entries = [
      {
        type: 'message',
        message: { id: 'm1', role: 'assistant', content: [] },
      },
    ];
    const event = {
      type: 'message.updated',
      sessionId: 's1',
      message: {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
      },
    };
    const once = reconcileLiveEvent(entries, event, 's1');
    const twice = reconcileLiveEvent(
      once,
      {
        ...event,
        message: {
          ...event.message,
          content: [{ type: 'text', text: 'done!' }],
        },
      },
      's1',
    );
    expect(twice).toHaveLength(1);
    expect(JSON.stringify(twice)).toContain('done!');
  });

  it('keeps live tools renderable when updating nested and new calls', () => {
    const entries = [
      {
        type: 'message',
        message: {
          id: 'm1',
          role: 'assistant',
          content: [{ type: 'toolCall', toolCallId: 't1', name: 'read' }],
        },
      },
    ];
    const updated = reconcileLiveEvent(
      entries,
      {
        type: 'tool.updated',
        sessionId: 's1',
        tool: { toolCallId: 't1', toolName: 'read', args: { path: 'a.ts' } },
      },
      's1',
    );
    expect(updated).not.toBe(entries);
    expect(
      (entries[0] as { message: { content: unknown[] } }).message.content,
    ).toHaveLength(1);
    expect(updated[0]).toMatchObject({ type: 'message' });
    expect(
      (updated[0] as { message: { content: unknown[] } }).message.content,
    ).toHaveLength(1);
    expect(
      (updated[0] as { message: { content: unknown[] } }).message.content[0],
    ).toMatchObject({ type: 'toolCall', name: 'read' });
    const appended = reconcileLiveEvent(
      updated,
      {
        type: 'tool.started',
        sessionId: 's1',
        tool: { toolCallId: 't2', toolName: 'bash', args: { command: 'pwd' } },
      },
      's1',
    );
    expect(appended).toHaveLength(2);
    expect(JSON.stringify(appended[1])).toContain('"name":"bash"');
    const finished = reconcileLiveEvent(
      appended,
      {
        type: 'tool.finished',
        sessionId: 's1',
        tool: { toolCallId: 't2', toolName: 'bash', result: 'ok' },
      },
      's1',
    );
    expect(finished).toHaveLength(2);
    expect(finished[1]).toMatchObject({
      type: 'tool',
      tool: { name: 'bash', result: 'ok' },
    });
  });

  it('uses shared narration semantics without treating a header as speech', () => {
    const entries = toTranscriptEntries([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '**Inspecting files**' },
            { type: 'thinking', thinking: '**Checking tests**' },
          ],
        },
      },
    ]);
    expect(entries[0]?.entry).toMatchObject({
      kind: 'assistant',
      speaks: false,
      narration: 'announced',
    });
    expect(entries[0]?.text).toBeUndefined();
  });

  it('pairs persisted Pi tool results with calls and excludes result-only rows', () => {
    const callId = 'call-1';
    const entries = toTranscriptEntries([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: callId,
              name: 'read',
              arguments: { path: 'a.ts' },
            },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: callId,
          toolName: 'read',
          content: [{ type: 'text', text: 'file' }],
          isError: false,
        },
      },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.entry).toMatchObject({ kind: 'assistant' });
    expect(entries[1]?.entry).toMatchObject({ kind: 'tool', name: 'read' });
    expect(JSON.stringify(entries[1]?.raw)).toContain('"result"');
  });

  it('ignores events from the previous session', () => {
    const entries = [{ type: 'message', message: { id: 'm1' } }];
    expect(
      reconcileLiveEvent(
        entries,
        { type: 'message.updated', sessionId: 'old', message: { id: 'old' } },
        'new',
      ),
    ).toEqual(entries);
  });
});

describe('bottom-stick scrolling', () => {
  it('treats a small footer distance as bottom without following users who scroll up', () => {
    expect(isNearPageBottom(2_000, 1_100, 800)).toBe(true);
    expect(isNearPageBottom(2_000, 900, 800)).toBe(false);
  });
});
