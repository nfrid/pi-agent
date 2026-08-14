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
  newChatModelOptions,
  newChatPath,
  newChatRequest,
  newChatThinkingLevels,
  pendingChatPath,
  preferredNewChatRuntime,
  queueCommand,
  queuedMessagesForRuntime,
  queueRemoveCommand,
  readComposerDraft,
  resumeRuntimeRequest,
  runtimeSupportsImages,
  sessionDisplayTitle,
  sessionNavigationTarget,
  sessionPathForRuntime,
  shouldApplySessionMetadata,
  shouldShowActivityLead,
  shouldShowJumpToLatest,
  shouldShowQueuePanel,
  toTranscriptEntries,
  upsertQueuedMessage,
  writeComposerDraft,
} from './App';
import {
  activityGroupMetadata,
  activityGroupPresentation,
  buildTranscriptLandmarks,
  sampleTranscriptLandmarks,
} from './entities/transcript';
import {
  agentThreadRows,
  boundedAgentThreadRows,
} from './features/agent-thread-nav';
import {
  interactionKeyAction,
  selectedInteractionPreview,
  visualViewportKeyboardInset,
} from './features/session';
import { actionNeedsInput, paletteItems } from './routes/dashboard';

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

describe('project-scoped new chat', () => {
  it('uses the active workspace for context-free new chat entries', () => {
    const snapshot = {
      workspaces: [
        { id: 'dormant', active: false },
        { id: 'active', active: true },
      ],
    } as never;
    expect(newChatPath(snapshot)).toBe('/workspaces/active/new');
    expect(newChatPath({ workspaces: [] } as never)).toBe('/workspaces');
    expect(newChatPath(snapshot, 'dormant')).toBe('/workspaces/dormant/new');
    expect(pendingChatPath('workspace-1', 'runtime/1')).toBe(
      '/workspaces/workspace-1/new/pending/runtime%2F1',
    );
  });

  it('builds the first-message start request with optional model settings', () => {
    expect(newChatRequest('workspace-1', '  inspect this  ')).toEqual({
      workspaceId: 'workspace-1',
      initialPrompt: '  inspect this  ',
    });
    expect(
      newChatRequest('workspace-1', 'use luna', {
        provider: 'openai-codex',
        model: 'gpt-5.6-luna',
        thinking: 'high',
      }),
    ).toEqual({
      workspaceId: 'workspace-1',
      initialPrompt: 'use luna',
      model: {
        provider: 'openai-codex',
        model: 'gpt-5.6-luna',
        thinking: 'high',
      },
    });
  });

  it('prefers the most recently used active workspace model and effort', () => {
    const older = {
      cwd: '/workspace',
      online: true,
      lastSeenAt: 10,
      model: {
        provider: 'openai-codex',
        model: 'gpt-5.6-luna',
        thinking: 'medium',
      },
      modelCatalog: [
        { provider: 'anthropic', model: 'claude-opus-4-6' },
        { provider: 'openai-codex', model: 'gpt-5.6-luna' },
      ],
      thinkingLevels: ['off', 'medium', 'high'],
    } as RuntimeSnapshot;
    const latest = {
      ...older,
      lastSeenAt: 20,
      model: {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        thinking: 'high',
      },
    } as RuntimeSnapshot;
    const foreign = {
      ...latest,
      cwd: '/other',
      lastSeenAt: 30,
    } as RuntimeSnapshot;

    expect(
      preferredNewChatRuntime('/workspace', [older, foreign, latest]),
    ).toBe(latest);
    expect(
      newChatModelOptions([older, latest], latest).map(
        (model) => `${model.provider}/${model.model}`,
      ),
    ).toEqual(['anthropic/claude-opus-4-6', 'openai-codex/gpt-5.6-luna']);
    expect(latest.model).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      thinking: 'high',
    });
    expect(newChatThinkingLevels([older, latest], latest)).toEqual([
      'off',
      'medium',
      'high',
    ]);
  });

  it('deduplicates model options exposed by connected runtimes', () => {
    expect(
      newChatModelOptions([
        {
          model: { provider: 'openai-codex', model: 'gpt-5.6-luna' },
          modelCatalog: [
            {
              provider: 'openai-codex',
              model: 'gpt-5.6-luna',
              name: 'Luna',
            },
            { provider: 'anthropic', model: 'claude-opus-4-6' },
          ],
        } as RuntimeSnapshot,
        {
          modelCatalog: [{ provider: 'anthropic', model: 'claude-opus-4-6' }],
        } as RuntimeSnapshot,
      ]).map((model) => `${model.provider}/${model.model}`),
    ).toEqual(['openai-codex/gpt-5.6-luna', 'anthropic/claude-opus-4-6']);
  });

  it('builds a resume request for the existing session', () => {
    expect(resumeRuntimeRequest('workspace-1', 'session-1')).toEqual({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
    });
    expect(resumeRuntimeRequest(undefined, 'session-1')).toBeUndefined();
  });

  it('waits for a runtime session identity before choosing the session route', () => {
    expect(sessionPathForRuntime(undefined)).toBeUndefined();
    expect(
      sessionPathForRuntime({
        session: { id: 'session/1' },
      } as RuntimeSnapshot),
    ).toBe('/sessions/session%2F1');
  });
});

describe('command palette', () => {
  it('keeps navigation available without runtime capabilities and bounds sessions', () => {
    const snapshot = {
      runtimes: [],
      workspaces: [
        {
          id: 'workspace-1',
          name: 'Workspace',
          canonicalPath: '/workspace',
        },
      ],
      sessions: Array.from({ length: 437 }, (_, index) => ({
        id: `session-${index}`,
        cwd: '/workspace',
        updatedAt: index,
      })),
    } as never;
    const items = paletteItems(snapshot);
    expect(items.slice(0, 2).map((item) => item.title)).toEqual([
      'Dashboard',
      'New chat',
    ]);
    expect(items.filter((item) => item.kind === 'navigate')).toHaveLength(30);
    expect(items[5]?.title).toBe('Session: Untitled session');
    expect(items.at(-1)?.title).toBe('Workspace: Workspace');
    expect(items.some((item) => item.title === 'Session: session-436')).toBe(
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
      pendingInteractions: [],
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
        target: 'Alpha agent',
        runtime: { runtimeId: 'runtime-alpha', cwd: '/workspace/alpha' },
      },
      {
        title: 'Abort run',
        target: 'Beta agent',
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

describe('ask-user keyboard contract', () => {
  it('moves, numbers, submits, and cancels without submitting on navigation', () => {
    expect(interactionKeyAction('ArrowDown', 0, 3)).toEqual({
      type: 'move',
      index: 1,
    });
    expect(interactionKeyAction('ArrowUp', 0, 3)).toEqual({
      type: 'move',
      index: 0,
    });
    expect(interactionKeyAction('2', 0, 3)).toEqual({
      type: 'move',
      index: 1,
    });
    expect(interactionKeyAction('Enter', 1, 3)).toEqual({
      type: 'submit',
      index: 1,
    });
    expect(interactionKeyAction('Escape', 1, 3)).toEqual({
      type: 'cancel',
    });
    expect(interactionKeyAction('ArrowDown', 0, 0)).toBeUndefined();
    expect(interactionKeyAction('Escape', 1, 3, true)).toBeUndefined();
  });

  it('uses the selected choice preview and ignores custom-answer rows', () => {
    const choices = [
      { label: 'Custom', value: 'custom', custom: true },
      { label: 'First', value: 'first', preview: '# First' },
      { label: 'Second', value: 'second', preview: '## Second' },
    ];
    expect(selectedInteractionPreview(choices, 0)).toBe('# First');
    expect(selectedInteractionPreview(choices, 1)).toBe('## Second');
  });
});

describe('workspace-first agent navigation', () => {
  it('uses the current time until a live runtime has indexed session metadata', () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(700);
    const rows = agentThreadRows({
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
    } as never);
    dateNow.mockRestore();

    expect(rows.map((row) => row.id)).toEqual(['new-session', 'old-session']);
    expect(rows[0]).toMatchObject({ startedAt: 700, updatedAt: 700 });
  });

  it('keeps offline and dormant threads below everything else', () => {
    const snapshot = {
      runtimes: [
        {
          runtimeId: 'idle',
          liveState: 'idle',
          online: true,
          cwd: '/workspace/app',
          session: { id: 'idle-session', title: 'Old thread', entries: [] },
        },
        {
          runtimeId: 'offline',
          liveState: 'idle',
          online: false,
          cwd: '/workspace/app',
          session: {
            id: 'offline-session',
            title: 'Offline thread',
            entries: [],
          },
        },
        {
          runtimeId: 'failed',
          liveState: 'failed',
          online: true,
          cwd: '/workspace/app',
          session: {
            id: 'failed-session',
            title: 'Broken thread',
            entries: [],
          },
        },
        {
          runtimeId: 'working',
          liveState: 'working',
          online: true,
          cwd: '/workspace/app',
          session: {
            id: 'working-session',
            title: 'Current thread',
            entries: [],
          },
        },
        {
          runtimeId: 'compacting',
          liveState: 'compacting',
          online: true,
          cwd: '/workspace/app',
          session: {
            id: 'compacting-session',
            title: 'Compacting thread',
            entries: [],
          },
        },
      ],
      workspaces: [{ id: 'app', name: 'App', canonicalPath: '/workspace/app' }],
      sessions: [
        {
          id: 'idle-session',
          cwd: '/workspace/app',
          startedAt: 450,
          updatedAt: 2,
        },
        {
          id: 'offline-session',
          cwd: '/workspace/app',
          startedAt: 700,
          updatedAt: 7,
        },
        {
          id: 'failed-session',
          cwd: '/workspace/app',
          startedAt: 300,
          updatedAt: 3,
        },
        {
          id: 'working-session',
          cwd: '/workspace/app',
          startedAt: 400,
          updatedAt: 5,
        },
        {
          id: 'compacting-session',
          cwd: '/workspace/app',
          startedAt: 500,
          updatedAt: 1,
        },
        {
          id: 'dormant-session',
          cwd: '/workspace/app',
          startedAt: 600,
          updatedAt: 6,
        },
      ],
    } as never;
    const rows = agentThreadRows(snapshot);
    expect(rows.map((row) => [row.id, row.status])).toEqual([
      ['compacting-session', 'compacting'],
      ['idle-session', 'idle'],
      ['working-session', 'working'],
      ['failed-session', 'failed'],
      ['offline-session', 'offline'],
      ['dormant-session', 'dormant'],
    ]);
    expect(
      boundedAgentThreadRows(rows).map((row) => [row.id, row.status]),
    ).toEqual([
      ['compacting-session', 'compacting'],
      ['idle-session', 'idle'],
      ['working-session', 'working'],
      ['failed-session', 'failed'],
      ['offline-session', 'offline'],
      ['dormant-session', 'dormant'],
    ]);
    const offline = rows[4];
    if (!offline) throw new Error('offline row missing');
    const history = Array.from({ length: 100 }, (_, index) => ({
      ...offline,
      id: `history-${index}`,
      status: index % 2 === 0 ? ('offline' as const) : ('dormant' as const),
      updatedAt: index,
    }));
    expect(
      boundedAgentThreadRows([...rows.slice(0, 4), ...history]),
    ).toHaveLength(28);
    expect(
      boundedAgentThreadRows([...rows.slice(0, 4), ...history], 48),
    ).toHaveLength(52);
    const active = Array.from({ length: 60 }, (_, index) => ({
      ...rows[0],
      id: `active-${index}`,
      status: 'working' as const,
    }));
    expect(boundedAgentThreadRows([...active, ...history], 48)).toHaveLength(
      88,
    );
  });
});

describe('transcript outline and metadata', () => {
  it('keeps user turns and activity landmarks stable while exposing one tool count', () => {
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
    const landmarks = buildTranscriptLandmarks(items, []);
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
    expect(activityGroupMetadata({ toolCount: 1, failureCount: 0 })).toBe(
      '1 tool call',
    );
    expect(
      activityGroupPresentation({ status: 'settled', toolCount: 1 }, false)
        .label,
    ).not.toContain('tool');
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
