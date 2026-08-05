import { describe, expect, it } from 'vitest';
import {
  deriveSessionTitle,
  ExtensionSurfaceSchema,
  isBridgeEvent,
  LiveExtensionSurfaceSchema,
  MAX_FRAME_BYTES,
  MAX_QUEUE_DRAFT_TEXT,
  MAX_QUEUE_DRAFTS,
  MAX_RUNTIME_EXTENSION_SURFACES,
  parseBridgeCommand,
  parseDashboardEventEnvelope,
  parseDashboardStreamMessage,
  parseFrame,
  parseNormalizedMessagePayload,
  parseRuntimeExtensionSurface,
  parseRuntimeSnapshot,
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
        { type: 'message', message: { role: 'assistant', content: 'nope' } },
        {
          type: 'message',
          message: { role: 'user', content: 'x'.repeat(200) },
        },
      ]),
    ).toHaveLength(96);
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
    expect(
      parseDashboardStreamMessage({
        cursor: 2,
        emittedAt: 101,
        runtimeId: 'runtime-1',
        event: { type: 'agent.settled', sessionId: 'session-1' },
      }).cursor,
    ).toBe(2);
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
