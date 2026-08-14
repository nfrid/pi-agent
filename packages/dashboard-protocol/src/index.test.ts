import { describe, expect, it } from 'vitest';
import {
  ActiveDelegateTranscriptBaselineSchema,
  ComposerCommandCatalogueSchema,
  DASHBOARD_SUPPORTED_BUILTIN_COMMANDS,
  deriveSessionTitle,
  ExtensionSurfaceSchema,
  firstUserMessageText,
  isBridgeEvent,
  LiveExtensionSurfaceSchema,
  MAX_FRAME_BYTES,
  MAX_QUEUE_DRAFT_TEXT,
  MAX_QUEUE_DRAFTS,
  MAX_RUNTIME_EXTENSION_SURFACES,
  parseActiveDelegateTranscriptBaseline,
  parseBridgeCommand,
  parseBridgeEvent,
  parseComposerCommandCatalogue,
  parseDashboardEventEnvelope,
  parseDashboardStreamMessage,
  parseDelegateHistoryResponse,
  parseDelegateHistoryRunDetailResponse,
  parseFrame,
  parseNormalizedMessagePayload,
  parseRuntimeExtensionSurface,
  parseRuntimeSnapshot,
  parseSessionAdoptCommand,
  parseSessionApiResponse,
  RuntimeExtensionSurfaceSchema,
  redactImageData,
  serializeFrame,
  tryParseNormalizedToolPayload,
  validateBridgeCommand,
  validateSessionRenameRequest,
  validateStartRuntimeRequest,
  type WorkspaceTarget,
  workspaceForPath,
} from './index.js';

describe('dashboard protocol', () => {
  it('validates active delegate baselines and transcript upsert events', () => {
    const entry = {
      id: '2:tool-1',
      type: 'tool' as const,
      label: 'read source.ts',
      name: 'read',
      status: 'completed' as const,
      arguments: { path: 'source.ts' },
      result: { lines: 3 },
      run: 2,
    };
    expect(
      parseActiveDelegateTranscriptBaseline({
        version: 1,
        serverId: 'server-1',
        cursor: 4,
        sessionId: 'session-1',
        runtimeId: 'runtime-1',
        runtimeEpoch: 'epoch-1',
        runtimeSeq: 7,
        runs: [
          {
            runId: 'run-1',
            lineageId: 'lineage-1',
            name: 'Worker',
            kind: 'background',
            state: 'running',
            createdAt: 1,
            allowWrites: false,
            transcript: [entry],
          },
        ],
      }),
    ).toMatchObject({ runs: [{ transcript: [entry] }] });
    expect(
      parseBridgeEvent({
        type: 'delegate.transcript.updated',
        sessionId: 'session-1',
        lineageId: 'lineage-1',
        runId: 'run-1',
        entry,
      }),
    ).toMatchObject({ type: 'delegate.transcript.updated', entry });
    expect(ActiveDelegateTranscriptBaselineSchema).toBeDefined();
  });

  it('strictly separates summary history from one selected run detail', () => {
    const response = parseDelegateHistoryResponse({
      version: 2,
      sessionId: 'session-1',
      leafId: 'leaf-1',
      groups: [
        {
          id: 'lineage-1',
          runId: 'run-1',
          lineageId: 'lineage-1',
          name: 'Review',
          kind: 'foreground',
          state: 'success',
          createdAt: 1,
          allowWrites: false,
          runCount: 1,
          runs: [
            {
              runId: 'run-1',
              lineageId: 'lineage-1',
              name: 'Review',
              kind: 'foreground',
              state: 'success',
              createdAt: 1,
              allowWrites: false,
            },
          ],
        },
      ],
    });
    expect(response.groups[0]?.runs[0]).not.toHaveProperty('details');
    expect(() =>
      parseDelegateHistoryResponse({
        ...response,
        groups: [
          {
            ...response.groups[0],
            runs: [
              { ...response.groups[0]?.runs[0], details: { truncated: false } },
            ],
          },
        ],
      }),
    ).toThrow();
    expect(
      parseDelegateHistoryRunDetailResponse({
        version: 1,
        sessionId: 'session-1',
        leafId: 'leaf-1',
        lineageId: 'lineage-1',
        runId: 'run-1',
        run: {
          ...response.groups[0].runs[0],
          details: {
            response: 'The selected bounded response.',
            structuredResult: { valid: true, errors: [] },
            truncated: false,
          },
        },
      }),
    ).toMatchObject({
      run: { details: { response: 'The selected bounded response.' } },
    });
  });

  it('validates optional paginated session history metadata', () => {
    const response = {
      metadata: { id: 'session-1', file: '', cwd: '/tmp', updatedAt: 1 },
      entries: [],
      history: {
        version: 1,
        start: 10,
        end: 20,
        hasOlder: true,
        nextBefore: 'opaque-token',
      },
    };
    expect(parseSessionApiResponse(response).history).toEqual(response.history);
    expect(() =>
      parseSessionApiResponse({
        ...response,
        history: { ...response.history, version: 2 },
      }),
    ).toThrow();
    expect(() =>
      parseSessionApiResponse({
        ...response,
        history: { ...response.history, extra: true },
      }),
    ).toThrow();
  });

  it('bounds and rejects unknown session adoption command properties', () => {
    const command = {
      commandId: 'adopt-1',
      title: 'Legacy session',
      checkoutId: 'checkout-1',
    };
    expect(parseSessionAdoptCommand(command)).toEqual(command);
    expect(() =>
      parseSessionAdoptCommand({ ...command, extra: true }),
    ).toThrow();
    expect(() =>
      parseSessionAdoptCommand({ ...command, title: 'x'.repeat(513) }),
    ).toThrow();
  });

  it('preserves the complete first user prompt while deriving a short title', () => {
    const prompt = '  first line\nsecond line with full intent  ';
    const entries = [
      { type: 'message', message: { role: 'user', content: prompt } },
    ];
    expect(firstUserMessageText(entries)).toBe(prompt);
    expect(deriveSessionTitle(entries)).toBe(
      'first line second line with full intent',
    );
  });

  it('matches the closest workspace and uses explicit sources as tie-breakers', () => {
    const workspace = (
      id: string,
      canonicalPath: string,
      source: WorkspaceTarget['source'],
    ): WorkspaceTarget => ({
      id,
      name: id,
      path: canonicalPath,
      canonicalPath,
      source,
      active: source === 'tmux',
    });
    const zoxideParent = workspace('zoxide-parent', '/Users/me/.pi', 'zoxide');
    const tmuxChild = workspace('pi-config', '/Users/me/.pi/agent', 'tmux');
    expect(
      workspaceForPath('/Users/me/.pi/agent', [zoxideParent, tmuxChild])?.id,
    ).toBe('pi-config');
    expect(
      workspaceForPath('/Users/me/.pi/project', [
        workspace('tmux-home', '/Users/me', 'tmux'),
        workspace('zoxide-project', '/Users/me/.pi/project', 'zoxide'),
      ])?.id,
    ).toBe('zoxide-project');
    expect(
      workspaceForPath('/workspace', [
        workspace('zoxide', '/workspace', 'zoxide'),
        workspace('configured', '/workspace', 'sesh-config'),
      ])?.id,
    ).toBe('configured');
  });

  it('round trips bounded commands', () => {
    const frame = {
      kind: 'command' as const,
      command: { id: '1', type: 'followUp' as const, text: 'continue' },
    };
    expect(parseFrame(serializeFrame(frame))).toEqual(frame);
    expect(
      parseBridgeCommand({ id: 'cancel-compact', type: 'compact.cancel' }),
    ).toEqual({ id: 'cancel-compact', type: 'compact.cancel' });
  });

  it('accepts, normalizes, and bounds dashboard queue draft commands', () => {
    expect(
      parseBridgeCommand({
        id: 'command-1',
        type: 'queue.add',
        clientId: 'draft-1',
        mode: 'steer',
        text: '  inspect this  ',
      }),
    ).toEqual({
      id: 'command-1',
      type: 'queue.add',
      clientId: 'draft-1',
      mode: 'steer',
      text: 'inspect this',
    });
    expect(
      parseBridgeCommand({
        id: 'command-2',
        type: 'queueDraft.update',
        clientId: 'draft-1',
        mode: 'followUp',
        text: 'updated',
      }),
    ).toMatchObject({ type: 'queueDraft.update', mode: 'followUp' });
    expect(() =>
      parseBridgeCommand({
        id: 'command-3',
        type: 'queue.add',
        clientId: 'draft-1',
        mode: 'steer',
        text: ' '.repeat(MAX_QUEUE_DRAFT_TEXT),
      }),
    ).toThrow('text');
    expect(() =>
      parseBridgeCommand({
        id: 'command-4',
        type: 'queue.add',
        clientId: 'draft-1',
        mode: 'steer',
        text: 'x'.repeat(MAX_QUEUE_DRAFT_TEXT + 1),
      }),
    ).toThrow();
    expect(() =>
      parseBridgeCommand({
        id: 'command-5',
        type: 'queue.remove',
        clientId: 'draft-1',
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      parseRuntimeSnapshot({
        runtimeId: 'runtime-1',
        ownership: 'external',
        pid: 1,
        cwd: '/tmp',
        liveState: 'idle',
        session: { id: 'session-1', entries: [] },
        pendingInteractions: [],
        queueDrafts: Array.from(
          { length: MAX_QUEUE_DRAFTS + 1 },
          (_, index) => ({
            clientId: `draft-${index}`,
            mode: 'steer',
            text: 'x',
          }),
        ),
      }),
    ).toThrow();
  });

  it('accepts bounded image-only commands and redacts image bytes', () => {
    expect(
      validateBridgeCommand({
        id: 'image-1',
        type: 'prompt',
        text: '',
        images: [
          {
            type: 'image',
            path: '/tmp/dashboard-image',
            mediaType: 'image/png',
          },
        ],
      }),
    ).toMatchObject({ type: 'prompt', text: '', images: [{ type: 'image' }] });
    expect(
      redactImageData({
        content: [
          { type: 'image', data: 'large', mimeType: 'image/png' },
          {
            type: 'image',
            source: {
              type: 'base64',
              mediaType: 'image/jpeg',
              data: 'large',
            },
          },
          { type: 'base64', data: 'provider-shape' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/webp;base64,provider-url' },
          },
        ],
      }),
    ).toEqual({
      content: [
        { type: 'image', mimeType: 'image/png', omitted: true },
        {
          type: 'image',
          source: {
            type: 'base64',
            mediaType: 'image/jpeg',
            omitted: true,
          },
        },
        { type: 'base64', omitted: true },
        {
          type: 'image_url',
          image_url: { url: '[image data omitted]' },
        },
      ],
    });
  });

  it('rejects arbitrary commands and oversized frames', () => {
    expect(() =>
      validateBridgeCommand({ id: 'x', type: 'exec', command: 'rm -rf /' }),
    ).toThrow();
    expect(() => parseFrame('x'.repeat(MAX_FRAME_BYTES + 1))).toThrow(/size/);
  });

  it('validates rename commands and derives bounded first-user titles', () => {
    expect(
      validateBridgeCommand({
        id: 'x',
        type: 'setSessionName',
        name: ' Dashboard ',
      }),
    ).toEqual({ id: 'x', type: 'setSessionName', name: 'Dashboard' });
    expect(() =>
      validateBridgeCommand({
        id: 'x',
        type: 'setSessionName',
        name: 'Dashboard',
        extra: true,
      }),
    ).toThrow();
    expect(validateSessionRenameRequest({ name: '  Renamed  ' })).toEqual({
      name: 'Renamed',
    });
    expect(() => validateSessionRenameRequest({ name: 'x\n' })).toThrow();
    const title = deriveSessionTitle([
      { type: 'session', id: 's' },
      {
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '  fix\n  the   dashboard  ' }],
        },
      },
    ]);
    expect(title).toBe('fix the dashboard');
    expect(
      deriveSessionTitle([
        {
          type: 'message',
          message: {
            role: 'user',
            content:
              '<skill name="pi-docs" location="/skills/pi-docs/SKILL.md">\nLong injected instructions that should not become the title.\n</skill>\n\nFix the dashboard title',
          },
        },
      ]),
    ).toBe('[skill] pi-docs Fix the dashboard title');
    expect(
      deriveSessionTitle([
        { type: 'message', message: { role: 'assistant', content: 'nope' } },
        {
          type: 'message',
          message: { role: 'user', content: 'x'.repeat(200) },
        },
      ]),
    ).toHaveLength(96);
  });

  it('accepts compacting as a runtime live state', () => {
    expect(
      parseRuntimeSnapshot({
        runtimeId: 'compacting-runtime',
        ownership: 'external',
        pid: 1,
        cwd: '/tmp',
        liveState: 'compacting',
        session: { id: 'compacting-session', entries: [] },
        pendingInteractions: [],
      }).liveState,
    ).toBe('compacting');
  });

  it('semantically validates capability snapshots on runtime events', () => {
    const duplicate = {
      version: 1,
      capabilities: [
        { id: 'duplicate', version: '1' },
        { id: 'duplicate', version: '2' },
      ],
      manifests: [],
    };
    expect(() =>
      parseRuntimeSnapshot({
        runtimeId: 'r',
        ownership: 'external',
        pid: 1,
        cwd: '/tmp',
        liveState: 'idle',
        session: { id: 's', entries: [] },
        pendingInteractions: [],
        capabilities: duplicate,
      }),
    ).toThrow('Duplicate capability ID');
    expect(
      isBridgeEvent({
        type: 'runtime.stateChanged',
        state: 'working',
        snapshot: { capabilities: duplicate },
      }),
    ).toBe(false);
    expect(
      isBridgeEvent({
        type: 'runtime.heartbeat',
        state: 'idle',
        snapshot: {
          capabilities: {
            version: 1,
            capabilities: [{ id: 'valid', version: '1' }],
            manifests: [],
          },
        },
      }),
    ).toBe(true);
  });

  it('strictly validates each bridge event variant', () => {
    const helloSnapshot = {
      runtimeId: 'r',
      ownership: 'external',
      pid: 1,
      cwd: '/tmp',
      liveState: 'idle',
      session: { id: 's', entries: [] },
      pendingInteractions: [],
    };
    expect(
      isBridgeEvent({
        type: 'runtime.hello',
        protocolVersion: 1,
        capabilities: { heartbeat: true },
        snapshot: helloSnapshot,
      }),
    ).toBe(true);
    expect(
      isBridgeEvent({
        type: 'runtime.hello',
        protocolVersion: 1,
        capabilities: { heartbeat: false },
        snapshot: helloSnapshot,
      }),
    ).toBe(false);
    expect(
      isBridgeEvent({
        type: 'runtime.hello',
        protocolVersion: 1,
        snapshot: { runtimeId: 'r', pid: 1 },
      }),
    ).toBe(false);
    expect(
      isBridgeEvent({
        type: 'runtime.stateChanged',
        state: 'working',
        snapshot: { pid: -1 },
      }),
    ).toBe(false);
    expect(
      isBridgeEvent({
        type: 'session.changed',
        session: { id: 's', entries: [], unexpected: true },
      }),
    ).toBe(false);
    expect(
      isBridgeEvent({
        type: 'session.compacted',
        sessionId: 's',
        entry: {
          type: 'compaction',
          id: 'compact-1',
          summary: 'Earlier work.',
        },
      }),
    ).toBe(true);
    expect(
      isBridgeEvent({
        type: 'interaction.resolved',
        interactionId: 'i',
      }),
    ).toBe(false);
    expect(() =>
      parseFrame(
        JSON.stringify({
          kind: 'event',
          seq: 1,
          event: { type: 'runtime.nope' },
        }),
      ),
    ).toThrow();
  });

  it('parses normalized payloads and canonical event envelopes strictly', () => {
    const message = parseNormalizedMessagePayload({
      messageId: 'm-1',
      role: 'assistant',
      content: 'hello',
      phase: 'updated',
    });
    expect(message.messageId).toBe('m-1');
    expect(
      tryParseNormalizedToolPayload({
        toolCallId: 'tool-1',
        name: 'read',
        unexpected: true,
      }),
    ).toBeUndefined();
    for (const status of ['complete', 'completed', 'finished'] as const)
      expect(
        tryParseNormalizedToolPayload({
          toolCallId: `tool-${status}`,
          name: 'read',
          status,
        })?.status,
      ).toBe(status);
    expect(
      parseDashboardEventEnvelope({
        cursor: 1,
        emittedAt: 100,
        runtimeId: 'runtime-1',
        runtimeEpoch: 'epoch-1',
        runtimeSeq: 1,
        sessionId: 'session-1',
        event: {
          type: 'message.updated',
          sessionId: 'session-1',
          message,
        },
      }).cursor,
    ).toBe(1);
    expect(() =>
      parseDashboardEventEnvelope({
        cursor: 1,
        emittedAt: 100,
        event: { type: 'agent.settled', sessionId: 'session-1' },
        notification: {
          id: 'notification-1',
          kind: 'runtime-exited',
          title: 'Disconnected',
          body: 'Runtime went offline',
          createdAt: 100,
        },
      }),
    ).toThrow();
    expect(
      parseDashboardStreamMessage({
        cursor: 2,
        emittedAt: 101,
        runtimeId: 'runtime-1',
        event: { type: 'agent.settled', sessionId: 'session-1' },
      }).cursor,
    ).toBe(2);
    expect(
      parseDashboardStreamMessage({
        type: 'sessions',
        cursor: 3,
        emittedAt: 102,
        upsert: [
          {
            id: 'session-1',
            file: '/tmp/session.jsonl',
            cwd: '/tmp',
            updatedAt: 1,
          },
        ],
        remove: [],
      }),
    ).toMatchObject({ type: 'sessions', cursor: 3 });
    expect(() =>
      parseDashboardStreamMessage({
        type: 'sessions',
        cursor: 3,
        emittedAt: 102,
        upsert: [],
        remove: [],
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      parseDashboardStreamMessage({
        type: 'sessions',
        cursor: 4,
        emittedAt: 103,
        upsert: Array.from({ length: 4097 }, (_, index) => ({
          id: `session-${index}`,
          file: '',
          cwd: '/tmp',
          updatedAt: 1,
        })),
        remove: [],
      }),
    ).toThrow();
    expect(() =>
      parseDashboardStreamMessage({
        type: 'sessions',
        cursor: 4,
        emittedAt: 103,
        upsert: [],
        remove: Array.from({ length: 4097 }, (_, index) => `session-${index}`),
      }),
    ).toThrow();
  });

  it('retains explicit runtime/live surface aliases over the canonical contract', () => {
    expect(RuntimeExtensionSurfaceSchema).toBe(ExtensionSurfaceSchema);
    expect(LiveExtensionSurfaceSchema).toBe(RuntimeExtensionSurfaceSchema);
    expect(
      parseRuntimeExtensionSurface({
        id: 'tasks.current',
        rendererId: 'tasks.current',
        placement: 'left-rail',
        viewModel: {},
      }).rendererId,
    ).toBe('tasks.current');
  });

  it('accepts bounded extension surfaces and rejects an oversized catalogue', () => {
    const surface = {
      id: 'tasks.current',
      rendererId: 'tasks.current',
      placement: 'left-rail',
      viewModel: { version: 1, tasks: [] },
    };
    expect(
      parseRuntimeSnapshot({
        runtimeId: 'runtime-1',
        ownership: 'external',
        pid: 1,
        cwd: '/tmp',
        liveState: 'idle',
        session: { id: 'session-1', entries: [] },
        pendingInteractions: [],
        extensionSurfaces: [surface],
      }),
    ).toMatchObject({ extensionSurfaces: [surface] });
    expect(() =>
      parseRuntimeSnapshot({
        runtimeId: 'runtime-1',
        ownership: 'external',
        pid: 1,
        cwd: '/tmp',
        liveState: 'idle',
        session: { id: 'session-1', entries: [] },
        pendingInteractions: [],
        extensionSurfaces: Array.from(
          { length: MAX_RUNTIME_EXTENSION_SURFACES + 1 },
          (_, index) => ({
            ...surface,
            id: `surface-${index}`,
          }),
        ),
      }),
    ).toThrow();
  });

  it('validates bounded composer command catalogues and optional runtime entries', () => {
    const commands = [
      ...DASHBOARD_SUPPORTED_BUILTIN_COMMANDS,
      {
        name: 'review',
        description: 'Review a file',
        argumentHint: '<path>',
        source: 'prompt' as const,
      },
      { name: 'skill:demo', source: 'skill' as const },
    ];
    expect(parseComposerCommandCatalogue({ commands })).toEqual({ commands });
    expect(ComposerCommandCatalogueSchema).toBeDefined();
    expect(
      parseRuntimeSnapshot({
        runtimeId: 'runtime-1',
        ownership: 'external',
        pid: 1,
        cwd: '/tmp',
        liveState: 'idle',
        session: { id: 'session-1', entries: [] },
        pendingInteractions: [],
        composerCommands: commands,
      }).composerCommands,
    ).toEqual(commands);
    expect(() =>
      parseComposerCommandCatalogue({
        commands: Array.from({ length: 257 }, () => commands[0]),
      }),
    ).toThrow();
    expect(() =>
      parseComposerCommandCatalogue({
        commands: [{ name: 'extension', source: 'extension' }],
      }),
    ).toThrow();
    expect(() =>
      parseComposerCommandCatalogue({
        commands: [{ name: 'bad name', source: 'prompt' }],
      }),
    ).toThrow();
    expect(() =>
      parseComposerCommandCatalogue({
        commands: [{ name: 'bad/name', source: 'prompt' }],
      }),
    ).toThrow();
  });

  it('accepts bounded model and thinking catalogues in runtime snapshots', () => {
    expect(
      parseRuntimeSnapshot({
        runtimeId: 'runtime-1',
        ownership: 'external',
        pid: 1,
        cwd: '/tmp',
        liveState: 'idle',
        session: { id: 'session-1', entries: [] },
        pendingInteractions: [],
        modelCatalog: [
          {
            provider: 'test',
            model: 'vision',
            name: 'Vision',
            supportsImages: true,
          },
        ],
        thinkingLevels: ['off', 'high'],
      }),
    ).toMatchObject({
      modelCatalog: [{ model: 'vision', supportsImages: true }],
      thinkingLevels: ['off', 'high'],
    });
  });

  it('validates structured launch requests', () => {
    expect(
      validateStartRuntimeRequest({
        workspaceId: 'w',
        mode: 'read',
        model: { provider: 'p', model: 'm' },
      }).mode,
    ).toBe('read');
    expect(
      validateStartRuntimeRequest({
        workspaceId: 'w',
        model: { provider: 'p', model: 'm' },
      }).workspaceId,
    ).toBe('w');
    expect(() =>
      validateStartRuntimeRequest({ workspaceId: '../etc' }),
    ).not.toThrow();
    expect(() => validateStartRuntimeRequest({ workspaceId: '' })).toThrow();
    expect(() =>
      validateStartRuntimeRequest({
        workspaceId: 'w',
        initialPrompt: 'x'.repeat(100_001),
      }),
    ).toThrow('initial prompt');
  });
});
