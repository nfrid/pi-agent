import {
  hydrateTranscript,
  reduceTranscriptEvent,
  selectLegacyTranscriptEntries,
} from '@pi-dashboard/domain';
import type { BridgeEvent, RuntimeSnapshot } from '@pi-dashboard/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  addImageAttachments,
  asBrowserSnapshot,
  asSessionResponse,
  composerDraftStorageKey,
  contextIndicatorData,
  formatContextTokens,
  isNearPageBottom,
  mergeQueuedMessages,
  newProjectThreadPath,
  queueCommand,
  queuedMessagesForRuntime,
  queueRemoveCommand,
  readComposerDraft,
  resumeRuntimeRequest,
  runtimeSupportsImages,
  sessionDisplayTitle,
  sessionNavigationTarget,
  shouldApplySessionMetadata,
  shouldShowJumpToLatest,
  shouldShowQueuePanel,
  toTranscriptEntries,
  upsertQueuedMessage,
  writeComposerDraft,
} from './App';
import {
  buildTranscriptLandmarks,
  sampleTranscriptLandmarks,
} from './entities/transcript';
import {
  activeThreadDetails,
  agentThreadRows,
} from './features/agent-thread-nav';
import { visualViewportKeyboardInset } from './features/session';
import {
  actionNeedsInput,
  paletteItems,
  searchPaletteItems,
} from './routes/dashboard';

describe('session control geometry', () => {
  it('derives only the keyboard-covered portion of the layout viewport', () => {
    expect(visualViewportKeyboardInset(844, 520, 0)).toBe(324);
    expect(visualViewportKeyboardInset(844, 700, 120)).toBe(24);
    expect(visualViewportKeyboardInset(700, 700, 0)).toBe(0);
    expect(visualViewportKeyboardInset(600, 700, 0)).toBe(0);
  });
});

describe('queued message commands', () => {
  it('normalizes queue fixtures and creates explicit bridge commands', () => {
    const runtime = {
      queueDrafts: [
        { clientId: 'q1', mode: 'steer', text: 'inspect this' },
        { clientId: 'q1', mode: 'steer', text: 'duplicate snapshot item' },
        { clientId: 'q2', mode: 'followUp', text: 'then test it' },
        { clientId: '', mode: 'steer', text: 'ignore' },
      ],
    } as unknown as RuntimeSnapshot;
    expect(queuedMessagesForRuntime(runtime)).toEqual([
      { id: 'q1', mode: 'steer', text: 'inspect this' },
      { id: 'q2', mode: 'followUp', text: 'then test it' },
    ]);
    expect(
      queueCommand('queue.update', 'q1', 'steer', ' revised '),
    ).toMatchObject({
      type: 'queue.update',
      clientId: 'q1',
      mode: 'steer',
      text: 'revised',
    });
    expect(queueRemoveCommand('q2')).toMatchObject({
      type: 'queue.remove',
      clientId: 'q2',
    });
    expect(shouldShowQueuePanel('working', 0)).toBe(true);
    expect(shouldShowQueuePanel('compacting', 0)).toBe(true);
    expect(shouldShowQueuePanel('idle', 1)).toBe(true);
    expect(shouldShowQueuePanel('waiting', 1)).toBe(true);
    expect(shouldShowQueuePanel('idle', 0)).toBe(false);
  });

  it('keeps an accepted row through either command/event ordering', () => {
    const item = { id: 'q1', mode: 'steer' as const, text: 'inspect this' };
    // HTTP response first: retain the optimistic row until the live event.
    expect(mergeQueuedMessages([], [item])).toEqual([item]);
    // Live event first: the authoritative row replaces the optimistic one.
    expect(mergeQueuedMessages([item], [item])).toEqual([item]);
  });

  it('upserts an optimistic item when the server snapshot arrived first', () => {
    const serverItems = [
      { id: 'q1', mode: 'steer' as const, text: 'inspect this' },
    ];
    expect(
      upsertQueuedMessage(serverItems, {
        id: 'q1',
        mode: 'steer',
        text: 'inspect this',
      }),
    ).toEqual(serverItems);
    expect(
      upsertQueuedMessage(serverItems, {
        id: 'q2',
        mode: 'followUp',
        text: 'then test it',
      }),
    ).toEqual([
      ...serverItems,
      { id: 'q2', mode: 'followUp', text: 'then test it' },
    ]);
  });
});

describe('composer drafts', () => {
  it('persists drafts independently by session and removes empty values', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    try {
      const firstKey = composerDraftStorageKey('session/one');
      const secondKey = composerDraftStorageKey('session-two');
      writeComposerDraft('session/one', 'Keep this message');
      writeComposerDraft('session-two', 'Keep the other message');
      expect(readComposerDraft('session/one')).toBe('Keep this message');
      expect(readComposerDraft('session-two')).toBe('Keep the other message');
      expect(firstKey).not.toBe(secondKey);

      writeComposerDraft('session/one', '');
      expect(readComposerDraft('session/one')).toBe('');
      expect(values.has(firstKey)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('degrades safely when local storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('unavailable');
      },
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {
        throw new Error('unavailable');
      },
    });
    try {
      expect(readComposerDraft('session')).toBe('');
      expect(() => writeComposerDraft('session', 'draft')).not.toThrow();
      expect(() => writeComposerDraft('session', '')).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

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
    ).toMatchObject({
      role: 'user',
      imageCount: 1,
      images: [{ index: 0, mimeType: 'image/png', available: true }],
    });
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

describe('project thread navigation', () => {
  it('uses the first active persisted project', () => {
    expect(
      newProjectThreadPath({
        projects: [
          { id: 'archived-project', status: 'archived' },
          { id: 'active-project', status: 'active' },
        ],
      } as unknown as Parameters<typeof newProjectThreadPath>[0]),
    ).toBe('/projects/active-project/new');
    expect(newProjectThreadPath({ projects: [] })).toBe('/projects');
  });

  it('builds a resume request for the existing project checkout', () => {
    expect(
      resumeRuntimeRequest('project-1', 'checkout-1', 'session-1'),
    ).toEqual({
      projectId: 'project-1',
      checkoutId: 'checkout-1',
      sessionId: 'session-1',
    });
    expect(
      resumeRuntimeRequest('project-1', undefined, 'session-1'),
    ).toBeUndefined();
  });
});

describe('command palette', () => {
  it('keeps navigation available and indexes every ordinary thread', () => {
    const snapshot = {
      runtimes: [],
      sessions: Array.from({ length: 437 }, (_, index) => ({
        id: `session-${index}`,
        cwd: '/workspace',
        updatedAt: index,
      })),
    } as never;
    const items = paletteItems(snapshot);
    expect(items.slice(0, 2).map((item) => item.title)).toEqual([
      'New thread',
      'Dashboard',
    ]);
    expect(items.filter((item) => item.kind === 'navigate')).toHaveLength(439);
    expect(items[3]?.id).toBe('session:session-436');
    expect(items.at(-1)?.id).toBe('session:session-0');
    expect(searchPaletteItems(items, 'session-436')[0]?.item.id).toBe(
      'session:session-436',
    );
  });

  it('orders matching threads by lifecycle, activity, then creation', () => {
    const session = (id: string, updatedAt: number) => ({
      id,
      cwd: '/workspace',
      projectId: 'project-1',
      ...(id === 'active-thread-recent'
        ? { checkoutId: 'checkout-recent' }
        : {}),
      title: `Needle ${id}`,
      updatedAt,
    });
    const thread = (id: string, createdAt: number, updatedAt: number) => ({
      id: `thread-${id}`,
      projectId: 'project-1',
      title: `Needle ${id}`,
      status: 'completed',
      ...(id === 'active-thread-recent'
        ? { checkoutId: 'checkout-recent' }
        : {}),
      ...(id === 'settled' ? { settledAt: 1 } : {}),
      ...(id === 'archived' ? { archivedAt: 1 } : {}),
      createdAt,
      updatedAt,
    });
    const sessions = [
      session('active-thread-recent', 1),
      session('active-recent', 50),
      session('active-created-old', 10),
      session('active-created-new', 10),
      session('settled', 999),
      session('archived', 9_999),
    ];
    const threads = [
      thread('active-thread-recent', 1, 1_000),
      thread('active-recent', 1, 50),
      thread('active-created-old', 100, 10),
      thread('active-created-new', 200, 10),
      thread('settled', 300, 999),
      thread('archived', 400, 9_999),
    ];
    // Full thread records remain a lifecycle fallback when the direct-link
    // projection is present but does not carry its archive/settled timestamps.
    const links = sessions.map((entry) => ({
      sessionId: entry.id,
      threadId: `thread-${entry.id}`,
    }));
    const items = paletteItems(
      {
        runtimes: [],
        runs: [],
        sessions,
        projects: [{ id: 'project-1', title: 'Dashboard project' }],
        checkouts: [
          {
            id: 'checkout-recent',
            projectId: 'project-1',
            kind: 'worktree',
            path: '/workspace/.worktrees/recent',
            branch: 'feature/recent',
            status: 'ready',
            updatedAt: 1_000,
          },
        ],
      } as never,
      threads as never,
      links as never,
    );

    expect(
      searchPaletteItems(items, 'needle')
        .filter((result) => result.item.group === 'Threads')
        .map((result) => result.item.id),
    ).toEqual([
      'session:active-thread-recent',
      'session:active-recent',
      'session:active-created-new',
      'session:active-created-old',
      'session:settled',
      'session:archived',
    ]);
    expect(
      items.find((item) => item.id === 'session:active-thread-recent'),
    ).toMatchObject({
      description: 'Dashboard project / feature/recent',
      meta: 'ready',
      thread: {
        lifecycle: 'active',
        status: 'ready',
        project: 'Dashboard project',
        checkout: 'feature/recent',
        checkoutKind: 'worktree',
        checkoutPath: '/workspace/.worktrees/recent',
        activityAt: 1_000,
        createdAt: 1,
      },
    });
    expect(searchPaletteItems(items, 'feature/recent')[0]?.item.id).toBe(
      'session:active-thread-recent',
    );
    expect(searchPaletteItems(items, 'settled')[0]?.item.id).toBe(
      'session:settled',
    );
  });

  it('fuzzily ranks local catalogue fields and exposes visible match ranges', () => {
    const items = paletteItems({
      runtimes: [],
      sessions: [
        {
          id: 'session-1',
          cwd: '/workspace/dashboard',
          projectId: 'project-1',
          title: 'Reconnect diagnostics',
          updatedAt: 1,
        },
      ],
      projects: [
        {
          id: 'project-1',
          title: 'Dashboard',
          rootPath: '/workspace/dashboard',
          status: 'active',
        },
      ],
    } as never);
    const [result] = searchPaletteItems(items, 'reconect');
    expect(result?.item.id).toBe('session:session-1');
    expect(
      searchPaletteItems(items, 'dashboard').find(
        (entry) => entry.item.id === 'session:session-1',
      )?.matches.description,
    ).toBeDefined();
    expect(searchPaletteItems(items, '> new')[0]?.item.id).toBe('new-thread');
    expect(
      searchPaletteItems(items, '> new').every(
        (entry) => entry.item.group === 'Actions',
      ),
    ).toBe(true);
  });

  it('shows only current-thread actions until searching or using actions-only mode', () => {
    const runtime = (runtimeId: string, sessionId: string) => ({
      runtimeId,
      ownership: 'external',
      pid: 1,
      cwd: `/workspace/${runtimeId}`,
      liveState: 'working',
      online: true,
      session: { id: sessionId, title: runtimeId, entries: [] },
      capabilities: {
        version: 1,
        capabilities: [],
        manifests: [
          {
            id: `manifest-${runtimeId}`,
            version: '1',
            actions: [
              { id: 'runtime.abort', title: 'Abort run' },
              { id: 'activity-groups.set', title: 'Set activity groups' },
            ],
            renderers: [],
          },
        ],
      },
    });
    const items = paletteItems(
      {
        runtimes: [
          runtime('current-runtime', 'current-session'),
          runtime('other-runtime', 'other-session'),
        ],
        sessions: [],
      } as never,
      undefined,
      [],
      'current-session',
    );

    expect(
      searchPaletteItems(items, '').flatMap((result) =>
        result.item.kind === 'action' ? [result.item.runtime.runtimeId] : [],
      ),
    ).toEqual(['current-runtime']);
    expect(
      searchPaletteItems(items, '>').flatMap((result) =>
        result.item.kind === 'action' ? [result.item.runtime.runtimeId] : [],
      ),
    ).toEqual(['current-runtime', 'other-runtime']);
    expect(items.some((item) => item.id.includes('activity-groups.set'))).toBe(
      false,
    );
  });

  it('disambiguates identical actions by their runtime target', () => {
    const runtime = (runtimeId: string, title: string, cwd: string) => ({
      runtimeId,
      ownership: 'external',
      pid: 1,
      cwd,
      liveState: 'working',
      online: true,
      session: { id: `session-${runtimeId}`, title, entries: [] },
      capabilities: {
        version: 1,
        capabilities: [],
        manifests: [
          {
            id: `manifest-${runtimeId}`,
            version: '1',
            actions: [{ id: 'runtime.abort', title: 'Abort run' }],
            renderers: [],
          },
        ],
      },
    });
    const items = paletteItems({
      runtimes: [
        runtime('runtime-alpha', 'Alpha agent', '/workspace/alpha'),
        runtime('runtime-beta', 'Beta agent', '/workspace/beta'),
      ],
      workspaces: [],
      sessions: [],
    } as never).filter((item) => item.kind === 'action');
    expect(items).toMatchObject([
      {
        title: 'Abort run',
        meta: 'Alpha agent · /workspace/alpha',
        runtime: { runtimeId: 'runtime-alpha', cwd: '/workspace/alpha' },
      },
      {
        title: 'Abort run',
        meta: 'Beta agent · /workspace/beta',
        runtime: { runtimeId: 'runtime-beta', cwd: '/workspace/beta' },
      },
    ]);
  });

  it('treats missing and empty schemas as inputless while preserving required input', () => {
    expect(actionNeedsInput({})).toBe(false);
    expect(actionNeedsInput({ inputSchema: {} })).toBe(false);
    expect(actionNeedsInput({ inputSchema: { type: 'object' } })).toBe(false);
    expect(
      actionNeedsInput({
        inputSchema: { type: 'object', required: ['value'] },
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

  it('accepts paginated session history metadata for the web adapter', () => {
    const response = asSessionResponse({
      metadata: { id: 's1', file: '', cwd: '/tmp', updatedAt: 1 },
      entries: [],
      history: {
        version: 1,
        start: 0,
        end: 10,
        hasOlder: false,
      },
    });
    expect(response?.history).toMatchObject({
      version: 1,
      start: 0,
      end: 10,
      hasOlder: false,
    });
  });

  it('accepts bounded read-only branch topology without transcript payload copies', () => {
    const response = asSessionResponse({
      metadata: { id: 's1', file: '', cwd: '/tmp', updatedAt: 1 },
      entries: [],
      branchTopology: {
        activeLeafId: 'path-a',
        points: [
          {
            id: 'root-user',
            paths: [
              {
                id: 'path-a-entry',
                messageId: 'path-a',
                label: 'Try A',
                current: true,
              },
              {
                id: 'path-b-entry',
                messageId: 'path-b',
                label: 'Try B',
                current: false,
              },
            ],
          },
        ],
      },
    });
    expect(response?.branchTopology?.points[0]?.paths).toHaveLength(2);
    expect(response?.branchTopology?.activeLeafId).toBe('path-a');
  });

  it('rejects malformed and legacy runtime snapshots', () => {
    expect(asBrowserSnapshot({ runtimeId: 'runtime-1' })).toBeUndefined();
    expect(
      asBrowserSnapshot({
        revision: 1,
        runtimes: [],
        workspaces: [],
        sessions: [],
      }),
    ).toBeUndefined();
  });
});

describe('session latest control', () => {
  it('shows jump-to-latest only after leaving the latest viewport', () => {
    expect(shouldShowJumpToLatest(1000, 780, 200)).toBe(false);
    expect(shouldShowJumpToLatest(1600, 300, 600)).toBe(true);
  });
});

describe('session hydration cursor coverage', () => {
  it('does not let a stale metadata envelope roll back hydrated HTTP metadata', () => {
    expect(shouldApplySessionMetadata(8, 9)).toBe(false);
    expect(shouldApplySessionMetadata(10, 9)).toBe(true);
  });
});

describe('session replacement navigation', () => {
  const sessionEvent = (
    type: 'session.changed' | 'session.snapshot',
    id: string,
  ) =>
    ({ type, session: { id, entries: [] } }) as Extract<
      BridgeEvent,
      { type: 'session.changed' | 'session.snapshot' }
    >;

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
    // A route change to a dormant session resets the association before any
    // queued event is considered.
    expect(
      sessionNavigationTarget(
        'dormant-session',
        undefined,
        'runtime-1',
        sessionEvent('session.snapshot', 'new-session'),
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

describe('workspace-first agent navigation', () => {
  it('derives branch-first metadata from runtime, indexed, and configured resume data', () => {
    const runtimes = [
      {
        model: { provider: 'configured', model: 'default', thinking: 'low' },
        modelCatalog: [
          { provider: 'configured', model: 'default', supportsImages: false },
        ],
        thinkingLevels: ['low'],
      },
    ] as never;
    const indexed = {
      lastKnownModel: { provider: 'openai-codex', model: 'old' },
      lastKnownThinking: 'medium',
      lastKnownServiceTier: 'fast',
      lastKnownContextTokens: 42,
    };
    expect(
      activeThreadDetails(
        {
          status: 'idle',
          runtime: {
            model: {
              provider: 'openai-codex',
              model: 'current',
              thinking: 'high',
              serviceTier: 'ultrafast',
            },
            checkoutId: 'checkout-1',
            queueDrafts: [{ clientId: 'q1' }, { clientId: 'q2' }],
          },
          session: indexed,
        } as never,
        runtimes,
        [
          {
            id: 'checkout-1',
            kind: 'worktree',
            branch: 'feature/thread-metadata',
            path: '/repo/.worktrees/thread-metadata',
          },
        ] as never,
        { 'openai-codex/current': { alias: 'Current', color: '#ff79c6' } },
      ),
    ).toMatchObject({
      branch: 'feature/thread-metadata',
      checkoutKind: 'worktree',
      model: {
        id: 'openai-codex/current',
        alias: 'Current',
        color: '#ff79c6',
        serviceTier: 'ultrafast',
      },
      effort: { full: 'high', compact: 'h', color: 'orange' },
      queue: 2,
      checkoutPath: '/repo/.worktrees/thread-metadata',
    });
    expect(
      activeThreadDetails(
        { status: 'dormant', runtime: {}, session: indexed } as never,
        runtimes,
      ),
    ).toMatchObject({
      branch: 'main',
      checkoutKind: 'main',
      model: {
        id: 'openai-codex/old',
        alias: 'old',
        serviceTier: 'fast',
      },
      effort: { full: 'medium', compact: 'm', color: 'cyan' },
    });
    expect(
      activeThreadDetails(
        { status: 'dormant', cwd: '/repo', session: {} } as never,
        runtimes,
      ),
    ).toMatchObject({
      branch: 'main',
      model: { id: 'configured/default', alias: 'default' },
      effort: { full: 'low', compact: 'l', color: 'green' },
      checkoutPath: '',
    });
    expect(
      activeThreadDetails(
        {
          status: 'draft',
          draft: {
            model: { provider: 'configured', model: 'spark' },
            location: { kind: 'current' },
          },
        } as never,
        runtimes,
      ),
    ).toMatchObject({
      model: { id: 'configured/default', alias: 'default' },
      effort: { full: 'low', compact: 'l', color: 'green' },
    });
  });

  it('keeps unindexed live rows stable until session metadata arrives', () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(700);
    const snapshot = {
      runtimes: [
        {
          runtimeId: 'new',
          liveState: 'working',
          online: true,
          cwd: '/workspace/app',
          session: { id: 'new-session', title: 'New thread', entries: [] },
        },
        {
          runtimeId: 'old',
          liveState: 'working',
          online: true,
          cwd: '/workspace/app',
          session: { id: 'old-session', title: 'Old thread', entries: [] },
        },
      ],
      workspaces: [{ id: 'app', name: 'App', canonicalPath: '/workspace/app' }],
      sessions: [
        {
          id: 'old-session',
          cwd: '/workspace/app',
          startedAt: 600,
          updatedAt: 600,
        },
      ],
    };
    const first = agentThreadRows(snapshot as never);
    dateNow.mockReturnValue(800);
    const second = agentThreadRows({
      ...snapshot,
      runtimes: snapshot.runtimes.map((runtime) => ({
        ...runtime,
        extensionSurfaces: [{ id: 'delegate.status', viewModel: {} }],
      })),
    } as never);
    dateNow.mockRestore();

    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
    expect(second.find((row) => row.id === 'new-session')).toMatchObject({
      startedAt: undefined,
      updatedAt: undefined,
    });
  });
});

describe('transcript outline and metadata', () => {
  it('keeps user turns and assistant landmarks stable', () => {
    const items = toTranscriptEntries([
      { type: 'message', message: { role: 'user', content: 'First request' } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Inspecting files' }],
        },
      },
    ]);
    const landmarks = buildTranscriptLandmarks(items);
    expect(landmarks.map((landmark) => landmark.label)).toEqual([
      'First request',
    ]);
    const many = Array.from({ length: 500 }, (_, index) => ({
      key: `turn-${index}`,
      label: `Turn ${index}`,
      kind: 'user' as const,
      itemIndex: index,
    }));
    const sampled = sampleTranscriptLandmarks(many, 48);
    expect(sampled).toHaveLength(48);
    expect(sampled[0]?.key).toBe('turn-0');
    expect(sampled.at(-1)?.key).toBe('turn-499');
  });
});

describe('bottom-stick scrolling', () => {
  it('treats a small footer distance as bottom without following users who scroll up', () => {
    expect(isNearPageBottom(2_000, 1_100, 800)).toBe(true);
    expect(isNearPageBottom(2_000, 900, 800)).toBe(false);
  });
});
