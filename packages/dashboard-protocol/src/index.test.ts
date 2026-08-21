import { describe, expect, it } from 'vitest';
import {
  ActiveDelegateTranscriptBaselineSchema,
  ComposerCommandCatalogueSchema,
  DASHBOARD_SUPPORTED_BUILTIN_COMMANDS,
  DelegateWorkflowMetadataSchema,
  deriveSessionTitle,
  ExtensionSurfaceSchema,
  firstUserMessageText,
  isBridgeEvent,
  LiveDiagnosticsResponseSchema,
  LiveExtensionSurfaceSchema,
  MAX_FRAME_BYTES,
  MAX_QUEUE_DRAFT_TEXT,
  MAX_QUEUE_DRAFTS,
  MAX_RUNTIME_EXTENSION_SURFACES,
  MAX_SHELL_SNAPSHOT_BYTES,
  ProtocolInfoSchema,
  parseActiveDelegateTranscriptBaseline,
  parseAuthoritativeSessionSnapshot,
  parseBridgeCommand,
  parseBridgeEvent,
  parseComposerCommandCatalogue,
  parseDashboardEventEnvelope,
  parseDelegateHistoryResponse,
  parseDelegateHistoryRunDetailResponse,
  parseFrame,
  parseLiveDiagnosticsRequest,
  parseLiveDiagnosticsResponse,
  parseNormalizedMessagePayload,
  parsePinThreadCommand,
  parseProtocolInfo,
  parseRestoreThreadCommand,
  parseRuntimeCommandInput,
  parseRuntimeCommandOutput,
  parseRuntimeExtensionSurface,
  parseRuntimeSnapshot,
  parseSchema,
  parseSessionAdoptCommand,
  parseSessionApiResponse,
  parseSessionThreadLinks,
  parseShellSnapshotRequest,
  parseShellSnapshotResponse,
  parseThreadLifecycleCommandResult,
  parseThreadLifecycleEvent,
  parseUnpinThreadCommand,
  RuntimeExtensionSurfaceSchema,
  redactImageData,
  ShellSnapshotRequestSchema,
  serializeFrame,
  tryParseNormalizedToolPayload,
  validateBridgeCommand,
  validateSessionRenameRequest,
  validateStartRuntimeRequest,
  type WorkspaceTarget,
  workspaceForPath,
} from './index.js';

describe('dashboard protocol', () => {
  it('validates the exact session/thread projection without association fields elsewhere', () => {
    expect(
      parseSessionThreadLinks([
        {
          sessionId: 'session-1',
          threadId: 'thread-1',
          archivedAt: 10,
          pinnedAt: 20,
          activeRunId: 'run-1',
        },
      ]),
    ).toEqual([
      {
        sessionId: 'session-1',
        threadId: 'thread-1',
        archivedAt: 10,
        pinnedAt: 20,
        activeRunId: 'run-1',
      },
    ]);
    expect(() =>
      parseSessionThreadLinks([
        { sessionId: 'session-1', threadId: 'thread-1', extra: true },
      ]),
    ).toThrow();
  });

  it('validates durable thread lifecycle commands and events strictly', () => {
    const thread = {
      id: 'thread-1',
      projectId: 'project-1',
      title: 'Lifecycle',
      status: 'completed' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const event = {
      id: 1,
      threadId: thread.id,
      type: 'thread.archive' as const,
      commandId: 'archive-1',
      actor: 'user' as const,
      reason: 'user-command' as const,
      data: { archivedAt: 2 },
      occurredAt: 2,
    };
    expect(parseRestoreThreadCommand({ commandId: 'restore-1' })).toEqual({
      commandId: 'restore-1',
    });
    expect(parsePinThreadCommand({ commandId: 'pin-1' })).toEqual({
      commandId: 'pin-1',
    });
    expect(parseUnpinThreadCommand({ commandId: 'unpin-1' })).toEqual({
      commandId: 'unpin-1',
    });
    expect(parseThreadLifecycleEvent(event)).toEqual(event);
    expect(parseThreadLifecycleCommandResult({ thread, event })).toEqual({
      thread,
      event,
    });
    expect(() =>
      parseRestoreThreadCommand({ commandId: 'restore-1', extra: true }),
    ).toThrow();
    expect(() =>
      parseThreadLifecycleEvent({ ...event, type: 'thread.unknown' }),
    ).toThrow();
  });

  it('enforces canonical workflow identity and reference shapes', () => {
    const valid = {
      logicalId: 'foo-bar',
      attempt: 2,
      identity: 'foo-bar@2',
      state: 'scheduled',
      dependencies: ['gate@1'],
      waitingFor: ['gate@1'],
      inputs: [
        {
          node: 'gate',
          identity: 'gate@1',
          include: ['report'],
          label: 'gate report',
        },
      ],
      route: 'provider/model',
      createdAt: 1,
      scheduledAt: 1,
    };
    expect(parseSchema(DelegateWorkflowMetadataSchema, valid)).toEqual(valid);
    for (const value of [
      { ...valid, logicalId: 'Foo', identity: 'Foo@2' },
      { ...valid, identity: 'foo-bar@0' },
      { ...valid, identity: 'foo-bar@1000000000' },
      { ...valid, dependencies: ['gate'] },
    ])
      expect(() =>
        parseSchema(DelegateWorkflowMetadataSchema, value),
      ).toThrow();
  });

  it('validates a narrow per-session transcript reset event', () => {
    expect(
      parseBridgeEvent({
        type: 'session.transcript.reset',
        sessionId: 'session-1',
        reason: 'source-rewrite',
      }),
    ).toEqual({
      type: 'session.transcript.reset',
      sessionId: 'session-1',
      reason: 'source-rewrite',
    });
    expect(() =>
      parseBridgeEvent({
        type: 'session.transcript.reset',
        sessionId: 'session-1',
        reason: 'gap',
      }),
    ).toThrow();
  });

  it('validates typed runtime command input and receipts', () => {
    expect(
      parseRuntimeCommandInput({
        runtimeId: 'runtime-1',
        command: { id: 'command-1', type: 'abort' },
      }),
    ).toEqual({
      runtimeId: 'runtime-1',
      command: { id: 'command-1', type: 'abort' },
    });
    expect(
      parseRuntimeCommandOutput({
        runtimeId: 'runtime-1',
        commandId: 'command-1',
        status: 'already-completed',
        result: { accepted: true },
      }).status,
    ).toBe('already-completed');
    expect(() =>
      parseRuntimeCommandInput({
        runtimeId: 'runtime-1',
        command: { id: 'command-1', type: 'abort', extra: true },
      }),
    ).toThrow();
    expect(() =>
      parseRuntimeCommandOutput({
        runtimeId: 'runtime-1',
        commandId: 'command-1',
        status: 'unexpected',
        result: null,
      }),
    ).toThrow();
  });

  it('validates bounded live diagnostics contracts', () => {
    const diagnostics = {
      generation: 'generation-1',
      feed: 'shell',
      sequence: 4,
      subscribers: 1,
      subscriptionOpens: 3,
      resumedSubscriptions: 2,
      replayCount: 2,
      replayBytes: 120,
      replayCountLimit: 256,
      replayBytesLimit: 4_000_000,
      queueCountLimit: 128,
      queueBytesLimit: 4_000_000,
      maxFrameBytes: 2_000_000,
      oldestSequence: 3,
      newestSequence: 4,
      oldestCursor: 'oldest',
      newestCursor: 'newest',
      queuedCount: 0,
      queuedBytes: 0,
      coalesced: 2,
      overflowTerminations: 1,
      oversizedTerminations: 0,
      largestFrameBytes: 800,
      unavailableThroughSequence: 2,
      snapshotFallbacks: {
        initial: 1,
        invalid: 0,
        foreign: 1,
        future: 0,
        expired: 0,
        unavailable: 2,
        'too-large': 0,
      },
    };
    expect(parseLiveDiagnosticsRequest({})).toEqual({});
    expect(
      parseLiveDiagnosticsResponse({ shell: diagnostics, sessions: [] }),
    ).toEqual({ shell: diagnostics, sessions: [] });
    expect(LiveDiagnosticsResponseSchema).toBeDefined();
    expect(() => parseLiveDiagnosticsRequest({ extra: true })).toThrow();
    expect(() =>
      parseLiveDiagnosticsResponse({ shell: diagnostics }),
    ).toThrow();
  });

  it('negotiates strict protocol information and bootstrap requests', () => {
    const info = parseProtocolInfo({
      protocolVersion: 3,
      serverId: 'generation-1',
      capabilities: { shellSnapshot: true, sessionSnapshot: true },
    });
    expect(info.capabilities).toEqual({
      shellSnapshot: true,
      sessionSnapshot: true,
    });
    expect(parseShellSnapshotRequest({ protocolVersion: 3 })).toEqual({
      protocolVersion: 3,
    });
    expect(ProtocolInfoSchema).toBeDefined();
    expect(ShellSnapshotRequestSchema).toBeDefined();
    expect(() =>
      parseProtocolInfo({
        ...info,
        capabilities: {
          shellSnapshot: true,
          sessionSnapshot: true,
          extra: true,
        },
      }),
    ).toThrow();
    expect(() => parseProtocolInfo({ ...info, protocolVersion: 2 })).toThrow();
    expect(() => parseShellSnapshotRequest({ protocolVersion: '1' })).toThrow();
    expect(() =>
      parseShellSnapshotRequest({ protocolVersion: 3, extra: true }),
    ).toThrow();
  });

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
            sessionId: 'child-session-1',
            lineageId: 'lineage-1',
            name: 'Worker',
            kind: 'background',
            state: 'running',
            createdAt: 1,
            allowWrites: false,
            transcript: [entry],
            workflow: {
              logicalId: 'review',
              attempt: 1,
              identity: 'review@1',
              state: 'scheduled',
              dependencies: ['impl@1'],
              waitingFor: ['impl@1'],
              reason: 'waiting for impl@1',
              createdAt: 1,
              scheduledAt: 1,
            },
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
    expect(DelegateWorkflowMetadataSchema).toBeDefined();
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
          workflow: {
            logicalId: 'review',
            attempt: 1,
            identity: 'review@1',
            state: 'success',
            dependencies: [],
            createdAt: 1,
            scheduledAt: 1,
          },
          wake: {
            id: 'review-wake',
            state: 'entered',
            references: ['review@1'],
            createdAt: 1,
            enteredAt: 2,
            revision: 1,
            dispatchAttempts: 1,
          },
          runCount: 1,
          runs: [
            {
              runId: 'run-1',
              sessionId: 'child-session-1',
              lineageId: 'lineage-1',
              name: 'Review',
              kind: 'foreground',
              state: 'success',
              createdAt: 1,
              allowWrites: false,
              workflow: {
                logicalId: 'review',
                attempt: 1,
                identity: 'review@1',
                state: 'success',
                dependencies: [],
                createdAt: 1,
                scheduledAt: 1,
              },
              wake: {
                id: 'review-wake',
                state: 'entered',
                references: ['review@1'],
                createdAt: 1,
                enteredAt: 2,
                revision: 1,
                dispatchAttempts: 1,
              },
            },
          ],
        },
      ],
    });
    expect(response.groups[0]?.runs[0]).toMatchObject({
      sessionId: 'child-session-1',
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
      metadata: {
        id: 'session-1',
        file: '',
        cwd: '/tmp',
        updatedAt: 1,
        lastKnownModel: { provider: 'test', model: 'vision' },
        lastKnownThinking: 'medium',
        lastKnownContextTokens: 1234,
      },
      entries: [],
      history: {
        version: 1,
        start: 10,
        end: 20,
        hasOlder: true,
        nextBefore: 'opaque-token',
        leadingContinuation: true,
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

  it('keeps shell transcript-free and validates bounded authoritative sessions', () => {
    const shell = {
      snapshot: {
        serverId: 'server-1',
        revision: 2,
        cursor: 3,
        runtimes: [],
        workspaces: [],
        sessions: [],
        unread: [],
      },
      cursor: 3,
    };
    expect(parseShellSnapshotResponse(shell).snapshot.sessions).toEqual([]);
    expect(() =>
      parseShellSnapshotResponse({
        ...shell,
        cursor: 4,
        snapshot: {
          ...shell.snapshot,
          cursor: 4,
          runtimes: [
            {
              runtimeId: 'runtime-1',
              ownership: 'external',
              pid: 1,
              cwd: '/tmp',
              liveState: 'working',
              session: { id: 'session-1', entries: [{ type: 'message' }] },
            },
          ],
        },
      }),
    ).toThrow();
    const session = {
      metadata: { id: 'session-1', file: '', cwd: '/tmp', updatedAt: 1 },
      entries: [],
      entriesComplete: true,
      serverId: 'server-1',
      cursor: 3,
      active: {
        messages: [],
        tools: [],
        delegates: [],
        truncated: false,
      },
      completeThroughCursor: true,
    };
    expect(parseAuthoritativeSessionSnapshot(session).cursor).toBe(3);
    expect(() =>
      parseAuthoritativeSessionSnapshot({
        ...session,
        active: {
          ...session.active,
          messages: Array.from({ length: 257 }, (_, index) => ({
            messageId: `message-${index}`,
            role: 'assistant',
            content: 'x',
          })),
        },
      }),
    ).toThrow();
    expect(() =>
      parseShellSnapshotResponse({
        ...shell,
        snapshot: {
          ...shell.snapshot,
          usage: 'x'.repeat(MAX_SHELL_SNAPSHOT_BYTES),
        },
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
        protocolVersion: 2,
        capabilities: { heartbeat: true },
        snapshot: helloSnapshot,
      }),
    ).toBe(false);
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
        entryId: 'compact-1',
      }),
    ).toBe(true);
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
      tryParseNormalizedToolPayload({
        toolCallId: 'anchored-tool',
        name: 'read',
        timestamp: '2024-06-01T12:00:00.000Z',
      })?.timestamp,
    ).toBe('2024-06-01T12:00:00.000Z');
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
