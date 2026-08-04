import {
  hydrateTranscript,
  reduceTranscriptEvent,
  selectLegacyTranscriptEntries,
} from '@pi-dashboard/domain';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  addImageAttachments,
  asBrowserSnapshot,
  asSessionResponse,
  contextIndicatorData,
  formatContextTokens,
  isNearPageBottom,
  runtimeSupportsImages,
  sessionDisplayTitle,
  sessionNavigationTarget,
  shouldShowActivityLead,
  toTranscriptEntries,
} from './App';
import type { DashboardEvent } from './dashboard-transport';

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

  it('renders redacted image-only user messages as attachments', () => {
    expect(
      toTranscriptEntries([
        {
          type: 'message',
          message: {
            role: 'user',
            content: [{ type: 'image', mimeType: 'image/png', omitted: true }],
          },
        },
      ])[0],
    ).toMatchObject({ role: 'user', imageCount: 1 });
  });

  it('requires an explicit image capability from the connected runtime', () => {
    const runtime = {
      model: { provider: 'test', model: 'vision' },
    } as RuntimeSnapshot;
    expect(runtimeSupportsImages(runtime)).toBe(false);
    expect(
      runtimeSupportsImages({
        ...runtime,
        model: { provider: 'test', model: 'vision', supportsImages: true },
      }),
    ).toBe(true);
  });
});

describe('dashboard snapshots', () => {
  it('rejects malformed session responses before rendering', () => {
    expect(asSessionResponse({ entries: [] })).toBeUndefined();
    expect(
      asSessionResponse({ metadata: { id: 's1', cwd: '/tmp' }, entries: [] }),
    ).toBeUndefined();
  });

  it('rejects malformed runtime snapshots and defaults legacy HTTP collections', () => {
    expect(asBrowserSnapshot({ runtimeId: 'runtime-1' })).toBeUndefined();
    expect(
      asBrowserSnapshot({
        revision: 1,
        runtimes: [],
        workspaces: [],
        sessions: [],
      }),
    ).toMatchObject({ serverId: 'legacy', unread: [] });
  });
});

describe('session replacement navigation', () => {
  const sessionEvent = (
    type: 'session.changed' | 'session.snapshot',
    id: string,
  ) => ({ type, session: { id, entries: [] } }) as DashboardEvent['event'];

  it.each([
    'session.changed',
    'session.snapshot',
  ] as const)('follows a runtime replacement delivered as %s without losing its association', (type) => {
    expect(
      sessionNavigationTarget(
        'old-session',
        'runtime-1',
        'runtime-1',
        sessionEvent(type, 'new-session'),
      ),
    ).toBe('new-session');
  });

  it('does not navigate for another runtime or the current session', () => {
    expect(
      sessionNavigationTarget(
        'old-session',
        'runtime-1',
        'runtime-2',
        sessionEvent('session.snapshot', 'new-session'),
      ),
    ).toBeUndefined();
    expect(
      sessionNavigationTarget(
        'old-session',
        'runtime-1',
        'runtime-1',
        sessionEvent('session.changed', 'old-session'),
      ),
    ).toBeUndefined();
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

describe('shared transcript projection web integration', () => {
  const message = (
    type: 'message.started' | 'message.updated' | 'message.finished',
    messageId: string,
    text: string,
  ) =>
    ({
      type,
      sessionId: 's1',
      message: {
        messageId,
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    }) as Parameters<typeof reduceTranscriptEvent>[1];

  const tool = (
    type: 'tool.started' | 'tool.updated' | 'tool.finished',
    toolCallId: string,
    result?: string,
  ) =>
    ({
      type,
      sessionId: 's1',
      tool: {
        toolCallId,
        name: 'read',
        ...(result === undefined ? {} : { result }),
      },
    }) as Parameters<typeof reduceTranscriptEvent>[1];

  it('hydrates, reduces, selects legacy entries, and preserves presentation mapping', () => {
    let projection = hydrateTranscript(
      [
        {
          type: 'message',
          message: {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Inspect this.' }],
          },
        },
      ],
      's1',
    );
    projection = reduceTranscriptEvent(
      projection,
      message('message.started', 'assistant-1', 'Preparing.'),
    );
    projection = reduceTranscriptEvent(
      projection,
      tool('tool.started', 'call-1'),
    );
    projection = reduceTranscriptEvent(
      projection,
      tool('tool.finished', 'call-1', 'done'),
    );
    projection = reduceTranscriptEvent(
      projection,
      message('message.finished', 'assistant-1', 'Finished.'),
    );

    const selected = selectLegacyTranscriptEntries(projection);
    const entries = toTranscriptEntries(selected);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ role: 'user', text: 'Inspect this.' });
    expect(entries[1]).toMatchObject({
      role: 'assistant',
      text: 'Finished.',
      entry: { kind: 'assistant', speaks: true },
    });
    expect(entries[2]).toMatchObject({
      entry: { kind: 'tool', name: 'read' },
    });
    expect(JSON.stringify(selected)).toContain('call-1');
  });

  it('keeps a finished entity stable when a later update is replayed', () => {
    let projection = hydrateTranscript([], 's1');
    projection = reduceTranscriptEvent(
      projection,
      message('message.finished', 'assistant-1', 'final'),
    );
    projection = reduceTranscriptEvent(
      projection,
      message('message.updated', 'assistant-1', 'stale'),
    );
    const selected = selectLegacyTranscriptEntries(projection);
    expect(selected).toHaveLength(1);
    expect(JSON.stringify(selected)).toContain('final');
    expect(JSON.stringify(selected)).not.toContain('stale');
  });

  it('uses selected projection entries rather than recursive provider identities', () => {
    const projection = hydrateTranscript([
      {
        type: 'message',
        message: {
          id: 'message-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          metadata: { id: 'must-not-be-used' },
        },
      },
    ]);
    const selected = selectLegacyTranscriptEntries(projection);
    expect(JSON.stringify(selected)).not.toContain('must-not-be-used');
    expect(toTranscriptEntries(selected)[0]?.key).toBe('message-1');
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

describe('bottom-stick scrolling', () => {
  it('treats a small footer distance as bottom without following users who scroll up', () => {
    expect(isNearPageBottom(2_000, 1_100, 800)).toBe(true);
    expect(isNearPageBottom(2_000, 900, 800)).toBe(false);
  });
});
