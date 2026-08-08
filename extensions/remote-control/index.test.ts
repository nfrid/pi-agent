import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  MAX_NON_IDEMPOTENT_ACTION_IDS,
  type NonIdempotentActionIdGuard,
} from '@pi-dashboard/extension-contributions';
import { describe, expect, it, vi } from 'vitest';
import {
  type BridgeCommand,
  parseFrame,
  type RuntimeSnapshot,
  serializeFrame,
} from '../../packages/dashboard-protocol/src/index';
import { InteractionBroker } from '../ask-user/broker';
import { askUserCapabilitySnapshot } from '../ask-user/contribution';
import { LiveSurfaceHub } from '../shared/runtime/live-surfaces';
import { setPendingProcessCount } from '../shared/runtime/pending-processes';
import {
  BridgeClient,
  composerCommandsSnapshot,
  createRemoteControlRuntime,
  dispatchDashboardCommand,
  dispatchDashboardInput,
  emitAgentSettlement,
  expandDashboardInput,
  flushQueueDrafts,
  LiveEventNormalizer,
  modelCatalogSnapshot,
  QueueDraftStore,
  shouldForwardLiveMessage,
  thinkingLevelsSnapshot,
  withoutOpaqueData,
} from './index';

const snapshot: RuntimeSnapshot = {
  runtimeId: 'runtime-test',
  ownership: 'external',
  pid: 1,
  cwd: '/tmp',
  liveState: 'idle',
  session: { id: 'session-test', entries: [] },
  pendingInteractions: [],
};

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1_000;
    const tick = () =>
      predicate()
        ? resolve()
        : Date.now() > deadline
          ? reject(new Error('timed out'))
          : setTimeout(tick, 5);
    tick();
  });
}

describe('dashboard input dispatch', () => {
  it('expands prompt templates with native positional argument semantics', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-prompt-'));
    const file = path.join(directory, 'review.md');
    await writeFile(
      file,
      `---\ndescription: Review code\n---\nReview $1 with \${2:-care}. All: $ARGUMENTS\n`,
    );
    expect(
      expandDashboardInput('/review "src/app.ts"', [
        {
          name: 'review',
          source: 'prompt',
          sourceInfo: {
            path: file,
            source: 'local',
            scope: 'user',
            origin: 'top-level',
            baseDir: directory,
          },
        },
      ]),
    ).toBe('Review src/app.ts with care. All: src/app.ts');
    await rm(directory, { recursive: true, force: true });
  });

  it('expands skills into the native skill block and preserves instructions', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-skill-'));
    const file = path.join(directory, 'SKILL.md');
    await writeFile(file, '---\nname: demo\n---\nFollow this skill.\n');
    expect(
      expandDashboardInput('/skill:demo inspect this', [
        {
          name: 'skill:demo',
          source: 'skill',
          sourceInfo: {
            path: file,
            source: 'local',
            scope: 'user',
            origin: 'top-level',
            baseDir: directory,
          },
        },
      ]),
    ).toBe(
      `<skill name="demo" location="${file}">\nReferences are relative to ${directory}.\n\nFollow this skill.\n</skill>\n\ninspect this`,
    );
    await rm(directory, { recursive: true, force: true });
  });

  it('dispatches bridge-native commands and rejects unavailable extension commands', async () => {
    const compact = vi.fn();
    const setSessionName = vi.fn();
    const sendUserMessage = vi.fn();
    const pi = {
      getCommands: () => [
        {
          name: 'custom',
          source: 'extension',
          sourceInfo: {
            path: '/tmp/custom.ts',
            source: 'local',
            scope: 'user',
            origin: 'top-level',
          },
        },
      ],
      setSessionName,
      sendUserMessage,
    } as unknown as ExtensionAPI;
    const context = { compact } as unknown as ExtensionContext;

    await expect(
      dispatchDashboardInput(pi, context, '/compact keep decisions'),
    ).resolves.toMatchObject({ command: 'compact' });
    expect(compact).toHaveBeenCalledWith({
      customInstructions: 'keep decisions',
    });
    await dispatchDashboardInput(pi, context, '/name Dashboard session');
    expect(setSessionName).toHaveBeenCalledWith('Dashboard session');
    await expect(
      dispatchDashboardCommand(pi, context, new InteractionBroker(), {
        id: 'rename-1',
        type: 'setSessionName',
        name: 'Bridge name',
      }),
    ).resolves.toEqual({ accepted: true });
    expect(setSessionName).toHaveBeenLastCalledWith('Bridge name');
    await expect(
      dispatchDashboardInput(pi, context, '/custom value'),
    ).rejects.toThrow('not available through the dashboard yet');
    await expect(
      dispatchDashboardInput(pi, context, '/reload'),
    ).rejects.toThrow('not available through the dashboard yet');
    expect(sendUserMessage).not.toHaveBeenCalled();

    await dispatchDashboardInput(pi, context, 'later', 'followUp');
    expect(sendUserMessage).toHaveBeenCalledWith('later', {
      deliverAs: 'followUp',
    });
  });

  it('dispatches temporary images as native Pi multimodal content', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-image-input-'));
    const file = path.join(directory, 'image.png');
    await writeFile(
      file,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const sendUserMessage = vi.fn();
    const pi = {
      getCommands: () => [],
      sendUserMessage,
    } as unknown as ExtensionAPI;
    await dispatchDashboardInput(
      pi,
      {} as ExtensionContext,
      'describe this',
      undefined,
      [{ type: 'image', path: file, mediaType: 'image/png' }],
    );
    expect(sendUserMessage).toHaveBeenCalledWith(
      [
        { type: 'text', text: 'describe this' },
        {
          type: 'image',
          mimeType: 'image/png',
          data: Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          ]).toString('base64'),
        },
      ],
      undefined,
    );
    await rm(directory, { recursive: true, force: true });
  });

  it('accepts an EOF-terminated frontmatter delimiter', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-prompt-eof-'));
    const file = path.join(directory, 'empty.md');
    await writeFile(file, '---\r\ndescription: Empty\r\n---');
    expect(
      expandDashboardInput('/empty', [
        {
          name: 'empty',
          source: 'prompt',
          sourceInfo: {
            path: file,
            source: 'local',
            scope: 'user',
            origin: 'top-level',
            baseDir: directory,
          },
        },
      ]),
    ).toBe('');
    await rm(directory, { recursive: true, force: true });
  });
});

describe('remote event normalization', () => {
  it('preserves only allowlisted steering metadata on the wire', () => {
    expect(
      withoutOpaqueData({
        type: 'message.updated',
        sessionId: 'session-test',
        message: {
          messageId: 'message-test',
          role: 'user',
          content: 'Redirect',
          phase: 'updated',
          data: { deliveryMode: 'steer', providerSecret: 'discard me' },
        },
      }),
    ).toMatchObject({
      message: { data: { deliveryMode: 'steer' } },
    });
    expect(
      withoutOpaqueData({
        type: 'message.updated',
        sessionId: 'session-test',
        message: {
          messageId: 'message-test',
          role: 'assistant',
          content: 'Continuing',
          phase: 'updated',
          data: { providerSecret: 'discard me' },
        },
      }),
    ).not.toHaveProperty('message.data');
  });

  it('suppresses duplicate tool-result messages from the live transcript', () => {
    expect(
      shouldForwardLiveMessage({
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'done' }],
        },
      }),
    ).toBe(false);
    expect(
      shouldForwardLiveMessage({
        message: { role: 'assistant', content: 'Continuing.' },
      }),
    ).toBe(true);
    expect(shouldForwardLiveMessage({ role: 'user', content: 'Prompt' })).toBe(
      true,
    );
  });

  it('correlates id-less message phases and keeps the live ID when responseId arrives late', () => {
    const normalizer = new LiveEventNormalizer('runtime-epoch');
    const started = normalizer.normalizeMessage('started', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    });
    const updated = normalizer.normalizeMessage('updated', {
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: ' there',
      },
    });
    const finished = normalizer.normalizeMessage('finished', {
      message: { role: 'assistant', content: 'Hi there' },
      responseId: 'provider-response-1',
    });

    expect(started.messageId).toBe('runtime-epoch:1');
    expect(updated.messageId).toBe(started.messageId);
    expect(finished.messageId).toBe(started.messageId);
    expect(updated.content).toEqual([{ type: 'text', text: 'Hi there' }]);
    expect(finished.content).toBe('Hi there');

    const userNormalizer = new LiveEventNormalizer('runtime-user');
    const userStarted = userNormalizer.normalizeMessage('started', {
      message: { role: 'user', content: 'Redirect' },
    });
    const userSteering = userNormalizer.normalizeMessage('updated', {
      message: {
        role: 'user',
        content: 'Redirect',
        data: { deliveryMode: 'steer' },
      },
    });
    expect(userSteering).toMatchObject({
      messageId: userStarted.messageId,
      data: { deliveryMode: 'steer' },
    });

    const deltaOnly = new LiveEventNormalizer('runtime-delta');
    deltaOnly.normalizeMessage('started', {
      message: { role: 'assistant', content: 'Hi' },
    });
    expect(
      deltaOnly.normalizeMessage('updated', {
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: ' there',
        },
      }).content,
    ).toBe('Hi there');

    const nextStarted = normalizer.normalizeMessage('started', {
      message: { role: 'assistant', content: 'next' },
    });
    const nextFinished = normalizer.normalizeMessage('finished', {
      message: { role: 'assistant', content: 'next' },
    });
    expect(nextStarted.messageId).toBe('runtime-epoch:2');
    expect(nextFinished.messageId).toBe(nextStarted.messageId);
    expect(nextStarted.messageId).not.toBe(started.messageId);
  });

  it('handles 0.84 delta-only events without requiring partial', () => {
    const normalizer = new LiveEventNormalizer('runtime-delta-only');
    normalizer.normalizeMessage('started', {
      message: { role: 'assistant', content: 'Hi' },
    });
    expect(
      normalizer.normalizeMessage('updated', {
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: ' there',
        },
      }),
    ).toMatchObject({ content: 'Hi there', phase: 'updated' });
  });

  it('does not leak 0.84 tool-call deltas into visible assistant text', () => {
    const normalizer = new LiveEventNormalizer('runtime-toolcall');
    normalizer.normalizeMessage('started', {
      message: { role: 'assistant', content: 'Visible' },
    });
    expect(
      normalizer.normalizeMessage('updated', {
        assistantMessageEvent: {
          type: 'toolcall_delta',
          contentIndex: 1,
          delta: '{"path":"private"}',
        },
      }).content,
    ).toBe('Visible');
    expect(
      normalizer.normalizeMessage('updated', {
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'private reasoning',
        },
      }).content,
    ).toBe('Visible');
  });

  it('uses text_start and text_end block boundaries', () => {
    const normalizer = new LiveEventNormalizer('runtime-text-blocks');
    normalizer.normalizeMessage('started', {
      message: { role: 'assistant', content: [] },
    });
    normalizer.normalizeMessage('updated', {
      assistantMessageEvent: {
        type: 'text_start',
        contentIndex: 0,
      },
    });
    const delta = normalizer.normalizeMessage('updated', {
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'draft',
      },
    });
    expect(delta.content).toEqual([{ type: 'text', text: 'draft' }]);
    expect(
      normalizer.normalizeMessage('updated', {
        assistantMessageEvent: {
          type: 'text_end',
          contentIndex: 0,
          content: 'authoritative',
        },
      }).content,
    ).toEqual([{ type: 'text', text: 'authoritative' }]);
  });

  it('does not append provider thinking deltas to visible assistant text', () => {
    const normalizer = new LiveEventNormalizer('runtime-thinking');
    normalizer.normalizeMessage('started', {
      message: { role: 'assistant', content: '' },
    });
    expect(
      normalizer.normalizeMessage('updated', {
        assistantMessageEvent: {
          type: 'thinking_delta',
          delta: 'private reasoning',
        },
      }).content,
    ).toBe('');
  });

  it('uses Pi toolCallId and preserves direct tool execution fields', () => {
    const normalizer = new LiveEventNormalizer('runtime-epoch');
    expect(
      normalizer.normalizeTool('started', {
        toolCallId: 'read-1',
        toolName: 'read',
        args: { path: '/tmp/file' },
      }),
    ).toMatchObject({
      toolCallId: 'read-1',
      name: 'read',
      arguments: { path: '/tmp/file' },
      phase: 'started',
      status: 'running',
    });
    expect(
      normalizer.normalizeTool('finished', {
        toolCallId: 'read-1',
        result: 'contents',
        isError: false,
      }),
    ).toMatchObject({
      toolCallId: 'read-1',
      name: 'read',
      result: 'contents',
      isError: false,
      phase: 'finished',
      status: 'completed',
    });
  });
});

describe('Pi 0.84 runtime catalogues', () => {
  it('advertises supported builtins and prompt/skill commands but not extensions', () => {
    const commands = composerCommandsSnapshot({
      getCommands: () => [
        {
          name: 'review',
          description: 'Review code\nwith context',
          argumentHint: '<path>',
          source: 'prompt',
        },
        {
          name: 'demo',
          description: 'Use the demo skill',
          source: 'skill',
        },
        { name: 'secret', source: 'extension' },
      ],
    } as unknown as ExtensionAPI);
    expect(commands).toEqual([
      expect.objectContaining({ name: 'compact', source: 'builtin' }),
      expect.objectContaining({ name: 'name', source: 'builtin' }),
      expect.objectContaining({ name: 'model', source: 'builtin' }),
      expect.objectContaining({ name: 'quit', source: 'builtin' }),
      {
        name: 'review',
        description: 'Review codewith context',
        argumentHint: '<path>',
        source: 'prompt',
      },
      {
        name: 'skill:demo',
        description: 'Use the demo skill',
        source: 'skill',
      },
    ]);
    expect(commands).not.toContainEqual(
      expect.objectContaining({ name: 'secret' }),
    );
  });

  it('bounds runtime composer commands', () => {
    const commands = composerCommandsSnapshot({
      getCommands: () =>
        Array.from({ length: 400 }, (_, index) => ({
          name: `prompt-${index}`,
          description: 'd'.repeat(2_000),
          argumentHint: 'h'.repeat(500),
          source: 'prompt',
        })),
    } as unknown as ExtensionAPI);
    expect(commands).toHaveLength(256);
    expect(commands.at(-1)?.description).toHaveLength(1_024);
    expect(commands.at(-1)?.argumentHint).toHaveLength(256);
  });

  it('includes the command catalogue in runtime snapshots', () => {
    const runtime = createRemoteControlRuntime({
      getCommands: () => [
        { name: 'review', source: 'prompt', description: 'Review code' },
        { name: 'ignored', source: 'extension' },
      ],
    } as unknown as ExtensionAPI);
    expect(runtime?.snapshot().composerCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'compact', source: 'builtin' }),
        expect.objectContaining({ name: 'review', source: 'prompt' }),
      ]),
    );
    expect(runtime?.snapshot().composerCommands).not.toContainEqual(
      expect.objectContaining({ name: 'ignored' }),
    );
  });

  it('publishes scoped models instead of the full available catalogue', () => {
    const scoped = {
      provider: 'scoped-provider',
      id: 'scoped-model',
      name: 'Scoped model',
      input: ['text'],
    };
    const available = {
      provider: 'other-provider',
      id: 'other-model',
      input: ['image'],
    };
    const ctx = {
      scopedModels: [{ model: scoped }],
      modelRegistry: {
        getAvailable: () => [scoped, available],
        hasConfiguredAuth: (model: { provider: string }) =>
          model.provider === 'scoped-provider',
      },
    } as unknown as ExtensionContext;

    expect(modelCatalogSnapshot(ctx)).toEqual([
      {
        provider: 'scoped-provider',
        model: 'scoped-model',
        name: 'Scoped model',
        supportsImages: false,
      },
    ]);
  });

  it('falls back to models from configured providers when scope is empty', () => {
    const configured = {
      provider: 'configured',
      id: 'model',
      input: ['image'],
    };
    const ctx = {
      scopedModels: [],
      modelRegistry: {
        getAvailable: () => [
          configured,
          { provider: 'unconfigured', id: 'other', input: ['text'] },
        ],
        hasConfiguredAuth: (model: { provider: string }) =>
          model.provider === 'configured',
      },
    } as unknown as ExtensionContext;
    expect(modelCatalogSnapshot(ctx)).toMatchObject([
      { provider: 'configured', model: 'model', supportsImages: true },
    ]);
  });

  it('includes Pi 0.84 max thinking', () => {
    expect(thinkingLevelsSnapshot()).toContain('max');
  });
});

describe('dashboard-owned queue drafts', () => {
  it('rejects duplicate and unknown client ids while enforcing lifecycle bounds', () => {
    const store = new QueueDraftStore();
    expect(() =>
      store.add({ clientId: 'draft-1', mode: 'steer', text: 'x' }),
    ).toThrow('session');
    store.setSession('session-1');
    store.add({ clientId: 'draft-1', mode: 'steer', text: 'x' });
    expect(() =>
      store.add({ clientId: 'draft-1', mode: 'followUp', text: 'duplicate' }),
    ).toThrow('already exists');
    expect(() =>
      store.update({ clientId: 'unknown', mode: 'steer', text: 'x' }),
    ).toThrow('unknown');
    expect(() => store.remove('unknown')).toThrow('unknown');
    expect(() =>
      store.add({ clientId: 'bad', mode: 'steer', text: ' '.repeat(20_000) }),
    ).toThrow('invalid');
    for (let index = 2; index < 33; index += 1)
      store.add({
        clientId: `draft-${index}`,
        mode: 'steer',
        text: `${index}`,
      });
    expect(() =>
      store.add({
        clientId: 'draft-overflow',
        mode: 'steer',
        text: 'overflow',
      }),
    ).toThrow('full');
    expect(store.list()).toHaveLength(32);
    store.setSession('session-2');
    expect(store.list()).toEqual([]);
  });

  it('flushes each mode once, restores failed sends, and ignores stale sessions', () => {
    const sendUserMessage = vi.fn((text: string) => {
      if (text === 'fails') throw new Error('Pi queue rejected message');
    });
    const runtime = createRemoteControlRuntime({} as ExtensionAPI);
    if (!runtime) throw new Error('runtime was not created');
    const contextFor = (id: string) =>
      ({
        cwd: '/tmp',
        model: undefined,
        thinkingLevel: 'off',
        sessionManager: {
          getBranch: () => [],
          getSessionId: () => id,
          getSessionFile: () => undefined,
          getSessionName: () => undefined,
          getCwd: () => '/tmp',
          getLeafId: () => undefined,
        },
        getContextUsage: () => undefined,
        isIdle: () => false,
      }) as unknown as ExtensionContext;
    const first = contextFor('session-queue-1');
    runtime.setContext(first);
    runtime.eventNormalizer.normalizeMessage('started', {
      message: { role: 'assistant', content: 'old session text' },
    });
    runtime.queueDrafts.add({
      clientId: 'steer-1',
      mode: 'steer',
      text: 'steer first',
    });
    runtime.queueDrafts.add({
      clientId: 'follow-1',
      mode: 'followUp',
      text: 'follow later',
    });
    runtime.queueDrafts.add({
      clientId: 'steer-2',
      mode: 'steer',
      text: 'fails',
    });
    flushQueueDrafts(
      runtime,
      { sendUserMessage } as unknown as ExtensionAPI,
      first,
      'steer',
    );
    expect(sendUserMessage).toHaveBeenNthCalledWith(1, 'steer first', {
      deliverAs: 'steer',
    });
    expect(sendUserMessage).toHaveBeenNthCalledWith(2, 'fails', {
      deliverAs: 'steer',
    });
    expect(runtime.queueDrafts.list()).toEqual([
      { clientId: 'follow-1', mode: 'followUp', text: 'follow later' },
      { clientId: 'steer-2', mode: 'steer', text: 'fails' },
    ]);
    sendUserMessage.mockImplementation(() => undefined);
    flushQueueDrafts(
      runtime,
      { sendUserMessage } as unknown as ExtensionAPI,
      first,
      'steer',
    );
    expect(runtime.queueDrafts.list()).toEqual([
      { clientId: 'follow-1', mode: 'followUp', text: 'follow later' },
    ]);
    flushQueueDrafts(
      runtime,
      { sendUserMessage } as unknown as ExtensionAPI,
      first,
      'followUp',
    );
    expect(sendUserMessage).toHaveBeenLastCalledWith('follow later', {
      deliverAs: 'followUp',
    });
    const second = contextFor('session-queue-2');
    runtime.setContext(second);
    expect(runtime.isCurrent(first)).toBe(false);
    expect(
      runtime.eventNormalizer.normalizeMessage('updated', {
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'new session text',
        },
      }).content,
    ).toEqual([{ type: 'text', text: 'new session text' }]);
    runtime.queueDrafts.add({
      clientId: 'new-session',
      mode: 'steer',
      text: 'new',
    });
    expect(
      flushQueueDrafts(
        runtime,
        { sendUserMessage } as unknown as ExtensionAPI,
        first,
        'steer',
      ),
    ).toBe(false);
    expect(runtime.queueDrafts.list()).toEqual([
      { clientId: 'new-session', mode: 'steer', text: 'new' },
    ]);
    // A late shutdown callback from the replaced context must not clear the
    // active session's bridge state.
    runtime.clearContext(first);
    expect(runtime.snapshot().session.id).toBe('session-queue-2');
    runtime.clearContext(second);
    expect(runtime.queueDrafts.list()).toEqual([]);
  });

  it('dispatches queue commands into the current session store', async () => {
    const store = new QueueDraftStore();
    store.setSession('session-commands');
    const commandContext = {
      isIdle: () => false,
    } as unknown as ExtensionContext;
    await expect(
      dispatchDashboardCommand(
        {} as ExtensionAPI,
        commandContext,
        new InteractionBroker(),
        {
          id: 'add-1',
          type: 'queue.add',
          clientId: 'client-1',
          mode: 'followUp',
          text: '  draft  ',
        },
        undefined,
        store,
      ),
    ).resolves.toEqual({
      accepted: true,
      draft: { clientId: 'client-1', mode: 'followUp', text: 'draft' },
    });
    await expect(
      dispatchDashboardCommand(
        {} as ExtensionAPI,
        commandContext,
        new InteractionBroker(),
        {
          id: 'update-1',
          type: 'queue.update',
          clientId: 'client-1',
          mode: 'steer',
          text: 'updated',
        },
        undefined,
        store,
      ),
    ).resolves.toMatchObject({ accepted: true, draft: { mode: 'steer' } });
    await expect(
      dispatchDashboardCommand(
        {} as ExtensionAPI,
        commandContext,
        new InteractionBroker(),
        { id: 'remove-1', type: 'queue.remove', clientId: 'client-1' },
        undefined,
        store,
      ),
    ).resolves.toEqual({ accepted: true, clientId: 'client-1' });
  });
});

describe('remote-control bridge', () => {
  it('sends hello before accepting events from a connecting socket', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-bridge-order-'));
    const socketPath = path.join(directory, 'bridge.sock');
    const received: Array<Record<string, unknown>> = [];
    let buffer = '';
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += String(chunk);
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) received.push(JSON.parse(line) as Record<string, unknown>);
          newline = buffer.indexOf('\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = new BridgeClient({
      socketPath,
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      handleCommand: async () => ({ accepted: true }),
    });

    client.start();
    expect(
      client.sendEvent({ type: 'session.snapshot', session: snapshot.session }),
    ).toBe(false);
    await waitFor(() => received.length >= 1);
    expect(
      (received[0]?.event as { snapshot?: RuntimeSnapshot }).snapshot?.session,
    ).toEqual(snapshot.session);

    expect(
      client.sendEvent({ type: 'session.snapshot', session: snapshot.session }),
    ).toBe(true);
    await waitFor(() => received.length >= 2);
    expect(
      received.slice(0, 2).map((frame) => ({
        seq: frame.seq,
        type: (frame.event as { type?: string }).type,
      })),
    ).toEqual([
      { seq: 1, type: 'runtime.hello' },
      { seq: 2, type: 'session.snapshot' },
    ]);
    client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('reconnects from a cached snapshot without touching a replaced session context', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-bridge-stale-'));
    const socketPath = path.join(directory, 'bridge.sock');
    const previousSocket = process.env.PI_DASHBOARD_SOCKET;
    process.env.PI_DASHBOARD_SOCKET = socketPath;
    const received: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        for (const line of String(chunk).split('\n').filter(Boolean))
          received.push(JSON.parse(line) as Record<string, unknown>);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    let stale = false;
    const active = <T>(value: T): T => {
      if (stale)
        throw new Error(
          'This extension ctx is stale after session replacement or reload.',
        );
      return value;
    };
    const manager = {
      getBranch: () =>
        active([
          {
            type: 'message',
            message: { role: 'user', content: '  inspect   title  ' },
          },
        ]),
      getSessionId: () => active('session-current'),
      getSessionFile: () => active('/tmp/session.jsonl'),
      getSessionName: () => active('Current session'),
      getCwd: () => active('/tmp/project'),
      getLeafId: () => active(undefined),
    };
    const context = {
      get cwd() {
        return active('/tmp/project');
      },
      get model() {
        return active(undefined);
      },
      get thinkingLevel() {
        return active('off');
      },
      sessionManager: manager,
      getContextUsage: () =>
        active({ tokens: 10, contextWindow: 1_000, percent: 1 }),
      isIdle: () => active(true),
    } as unknown as ExtensionContext;
    const runtime = createRemoteControlRuntime({} as ExtensionAPI);
    expect(runtime).toBeDefined();
    runtime?.setContext(context);
    expect(runtime?.snapshot().session.title).toBe('inspect title');
    const equivalentContext = {
      ...context,
      sessionManager: manager,
    } as unknown as ExtensionContext;
    expect(runtime?.isCurrent(equivalentContext)).toBe(true);
    runtime?.clearContext(equivalentContext);
    stale = true;
    runtime?.client.start();
    await waitFor(() =>
      received.some(
        (frame) =>
          (frame.event as { type?: string } | undefined)?.type ===
          'runtime.hello',
      ),
    );
    const hello = received.find(
      (frame) =>
        (frame.event as { type?: string } | undefined)?.type ===
        'runtime.hello',
    );
    expect(hello).toMatchObject({
      event: { snapshot: { session: { id: 'unknown' } } },
    });
    runtime?.client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousSocket === undefined) delete process.env.PI_DASHBOARD_SOCKET;
    else process.env.PI_DASHBOARD_SOCKET = previousSocket;
    await rm(directory, { recursive: true, force: true });
  });

  it('sends a full hello and acknowledges serialized daemon commands', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-bridge-'));
    const socketPath = path.join(directory, 'bridge.sock');
    let connection: net.Socket | undefined;
    const received: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
      connection = socket;
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          const frame = JSON.parse(line) as Record<string, unknown>;
          received.push(frame);
          if (frame.kind === 'command') {
            const command = frame.command as { id: string };
            socket.write(
              serializeFrame({
                kind: 'ack',
                id: command.id,
                ok: true,
                result: { accepted: true },
              }),
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = new BridgeClient({
      socketPath,
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      handleCommand: async (command) => ({ type: command.type }),
    });
    client.start();
    await waitFor(() =>
      received.some(
        (frame) =>
          (frame.event as { type?: string } | undefined)?.type ===
          'runtime.hello',
      ),
    );
    connection?.write(
      serializeFrame({
        kind: 'command',
        command: { id: 'daemon-1', type: 'abort' },
      }),
    );
    await waitFor(() =>
      received.some((frame) => frame.kind === 'ack' && frame.id === 'daemon-1'),
    );
    expect(
      received.find(
        (frame) =>
          (frame.event as { type?: string } | undefined)?.type ===
          'runtime.hello',
      ),
    ).toBeDefined();
    client.stop();
    connection?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('replays a stable prompt ACK after reconnect without executing Pi twice', async () => {
    let release!: () => void;
    const handleCommand = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          release = () => resolve({ accepted: true });
        }),
    );
    const client = new BridgeClient({
      socketPath: '/unused',
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      commandScope: () => 'session-stable',
      handleCommand,
    });
    const firstSocket = new net.Socket();
    const firstWrite = vi.spyOn(firstSocket, 'write').mockReturnValue(true);
    Reflect.set(client, 'socket', firstSocket);
    const enqueue = (
      Reflect.get(client, 'enqueue') as (
        command: BridgeCommand,
        socket: net.Socket,
      ) => void
    ).bind(client);
    const prompt = {
      id: 'run-prompt:run-1',
      type: 'prompt',
      text: 'Do it.',
    } as const;
    enqueue(prompt, firstSocket);
    await waitFor(() => handleCommand.mock.calls.length === 1);

    const replacement = new net.Socket();
    const replacementWrite = vi
      .spyOn(replacement, 'write')
      .mockReturnValue(true);
    Reflect.set(client, 'socket', replacement);
    enqueue(prompt, replacement);
    release();
    await waitFor(() =>
      replacementWrite.mock.calls.some((call) =>
        String(call[0]).includes('run-prompt:run-1'),
      ),
    );
    expect(handleCommand).toHaveBeenCalledOnce();
    expect(firstWrite).not.toHaveBeenCalledWith(
      expect.stringContaining('run-prompt:run-1'),
    );
    enqueue({ ...prompt, text: 'different payload' }, replacement);
    await waitFor(() =>
      replacementWrite.mock.calls.some((call) =>
        String(call[0]).includes('duplicate-command-id'),
      ),
    );
    enqueue(prompt, replacement);
    await waitFor(
      () =>
        replacementWrite.mock.calls.filter((call) =>
          String(call[0]).includes('run-prompt:run-1'),
        ).length >= 2,
    );
    client.stop();
    firstSocket.destroy();
  });

  it('retries failed prompts and isolates duplicate IDs by session scope', async () => {
    const handleCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error('Pi rejected the prompt'))
      .mockResolvedValue({ accepted: true });
    let scope = 'session-one';
    const client = new BridgeClient({
      socketPath: '/unused',
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      commandScope: () => scope,
      handleCommand,
    });
    const socket = new net.Socket();
    const write = vi.spyOn(socket, 'write').mockReturnValue(true);
    Reflect.set(client, 'socket', socket);
    const enqueue = (
      Reflect.get(client, 'enqueue') as (
        command: BridgeCommand,
        socket: net.Socket,
      ) => void
    ).bind(client);
    const prompt = {
      id: 'retry-prompt',
      type: 'prompt',
      text: 'Retry',
    } as const;
    enqueue(prompt, socket);
    await waitFor(() => handleCommand.mock.calls.length === 1);
    await waitFor(
      () =>
        (
          Reflect.get(client, 'semanticCommandsInFlight') as Map<
            unknown,
            unknown
          >
        ).size === 0,
    );
    enqueue(prompt, socket);
    await waitFor(() => handleCommand.mock.calls.length === 2);
    expect(handleCommand).toHaveBeenCalledTimes(2);
    scope = 'session-two';
    enqueue(prompt, socket);
    await waitFor(() => handleCommand.mock.calls.length === 3);
    expect(
      write.mock.calls.filter((call) =>
        String(call[0]).includes('retry-prompt'),
      ),
    ).toHaveLength(3);
    client.stop();
  });

  it('resolves queued duplicate waiters as stale when the bridge stops', async () => {
    let release!: () => void;
    const client = new BridgeClient({
      socketPath: '/unused',
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      commandScope: () => 'session-stop',
      handleCommand: async () =>
        new Promise<unknown>((resolve) => {
          release = () => resolve({ accepted: true });
        }),
    });
    const socket = new net.Socket();
    vi.spyOn(socket, 'write').mockReturnValue(true);
    Reflect.set(client, 'socket', socket);
    const enqueue = (
      Reflect.get(client, 'enqueue') as (
        command: BridgeCommand,
        socket: net.Socket,
      ) => void
    ).bind(client);
    const prompt = { id: 'stop-prompt', type: 'prompt', text: 'Stop' } as const;
    enqueue(prompt, socket);
    await waitFor(() => Boolean(release));
    enqueue(prompt, socket);
    client.stop();
    expect(
      (Reflect.get(client, 'semanticCommandsInFlight') as Map<unknown, unknown>)
        .size,
    ).toBe(0);
    release();
  });

  it('pushes live surface patches and unsubscribes on stop', () => {
    const hub = new LiveSurfaceHub();
    const client = new BridgeClient({
      socketPath: '/unused',
      runtimeId: 'runtime-test',
      snapshot: () => ({ ...snapshot, extensionSurfaces: hub.snapshot() }),
      liveSurfaces: hub,
      handleCommand: async () => ({ accepted: true }),
    });
    const socket = new net.Socket();
    const write = vi.spyOn(socket, 'write').mockReturnValue(true);
    Reflect.set(client, 'socket', socket);
    hub.publish('tasks', [
      {
        id: 'tasks.current',
        rendererId: 'tasks.current',
        placement: 'left-rail',
        viewModel: { version: 1, tasks: [] },
      },
    ]);
    const frame = JSON.parse(String(write.mock.calls[0]?.[0])) as {
      event: { type: string; snapshot?: RuntimeSnapshot };
    };
    expect(frame.event).toMatchObject({
      type: 'runtime.stateChanged',
      snapshot: { extensionSurfaces: [{ id: 'tasks.current' }] },
    });
    client.stop();
    hub.publish('tasks', []);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('processes queue drafts without waiting behind a long semantic command', async () => {
    let release: (() => void) | undefined;
    const handleCommand = vi.fn((command: BridgeCommand) => {
      if (command.id !== 'blocking') return Promise.resolve({ accepted: true });
      return new Promise<unknown>((resolve) => {
        release = () => resolve({ accepted: true });
      });
    });
    const client = new BridgeClient({
      socketPath: '/unused',
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      commandScope: () => 'session-current',
      handleCommand,
    });
    const socket = new net.Socket();
    const write = vi.spyOn(socket, 'write').mockReturnValue(true);
    Reflect.set(client, 'socket', socket);
    const enqueue = (
      Reflect.get(client, 'enqueue') as (
        command: BridgeCommand,
        socket: net.Socket,
      ) => void
    ).bind(client);
    enqueue({ id: 'blocking', type: 'abort' }, socket);
    enqueue(
      {
        id: 'draft-now',
        type: 'queue.add',
        clientId: 'draft-1',
        mode: 'steer',
        text: 'deliver at the next boundary',
      },
      socket,
    );
    await waitFor(() =>
      write.mock.calls.some((call) => String(call[0]).includes('draft-now')),
    );
    expect(handleCommand.mock.calls.map(([command]) => command.id)).toEqual([
      'blocking',
      'draft-now',
    ]);
    expect(
      write.mock.calls.some((call) => String(call[0]).includes('blocking')),
    ).toBe(false);
    release?.();
    await waitFor(() =>
      write.mock.calls.some((call) => String(call[0]).includes('blocking')),
    );
    client.stop();
  });

  it('uses one bounded duplicate guard for semantic bridge commands', () => {
    const client = new BridgeClient({
      socketPath: '/unused',
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      capabilities: askUserCapabilitySnapshot,
      handleCommand: async () => new Promise(() => undefined),
    });
    const socket = new net.Socket();
    const write = vi.spyOn(socket, 'write').mockReturnValue(true);
    Reflect.set(client, 'socket', socket);
    const enqueue = (
      Reflect.get(client, 'enqueue') as (
        command: unknown,
        socket: net.Socket,
      ) => void
    ).bind(client);
    const command = {
      id: 'answer-once',
      type: 'action.invoke',
      actionId: 'ask-user.answer',
      input: { interactionId: 'i', answer: 'yes' },
    };
    enqueue(command, socket);
    enqueue(command, socket);
    const guard = Reflect.get(
      client,
      'actionCommandIds',
    ) as NonIdempotentActionIdGuard;
    for (
      let index = guard.size;
      index < MAX_NON_IDEMPOTENT_ACTION_IDS;
      index += 1
    )
      expect(guard.reserve(`fill-${index}`)).toBe('reserved');
    enqueue({ ...command, id: 'answer-capacity' }, socket);
    const acks = write.mock.calls
      .map((call) => {
        try {
          return JSON.parse(String(call[0])) as {
            kind?: string;
            code?: string;
          };
        } catch {
          return undefined;
        }
      })
      .filter((frame) => frame?.kind === 'ack');
    expect(acks.map((ack) => ack?.code)).toEqual([
      'duplicate-action-id',
      'action-command-capacity',
    ]);
    expect(guard.has('answer-once')).toBe(true);
    client.stop();
  });

  it('rebuilds reconnect hello interactions from the live broker', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'pi-bridge-reconnect-state-'),
    );
    const socketPath = path.join(directory, 'bridge.sock');
    const broker = new InteractionBroker();
    const helloSnapshots: Array<RuntimeSnapshot> = [];
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          const frame = JSON.parse(line) as {
            event?: { type?: string; snapshot?: RuntimeSnapshot };
          };
          if (frame.event?.type !== 'runtime.hello' || !frame.event.snapshot)
            continue;
          helloSnapshots.push(frame.event.snapshot);
          if (connections === 1) socket.destroy();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const pendingPromise = broker.request(
      {
        type: 'ask_user',
        question: 'Continue?',
        choices: [{ label: 'Yes', value: 'yes' }],
        allowCustom: false,
      },
      () => new Promise<null>(() => undefined),
    );
    const interaction = broker.list()[0];
    if (!interaction) throw new Error('interaction was not created');
    const client = new BridgeClient({
      socketPath,
      runtimeId: 'runtime-test',
      snapshot: () => ({ ...snapshot, pendingInteractions: [interaction] }),
      broker,
      handleCommand: async () => ({ accepted: true }),
    });
    client.start();
    await waitFor(() => helloSnapshots.length >= 1);
    broker.cancel(interaction.id);
    await expect(pendingPromise).resolves.toBeNull();
    await waitFor(() => helloSnapshots.length >= 2);
    expect(helloSnapshots[1]?.pendingInteractions).toEqual([]);
    client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('bounds an oversized valid interaction instead of silently dropping it', () => {
    const client = new BridgeClient({
      socketPath: '/unused',
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      handleCommand: async () => ({ accepted: true }),
    });
    const socket = new net.Socket();
    const write = vi.spyOn(socket, 'write').mockReturnValue(true);
    Reflect.set(client, 'socket', socket);
    expect(
      client.sendEvent({
        type: 'interaction.requested',
        interaction: {
          id: 'oversized-interaction',
          type: 'ask_user',
          question: 'q'.repeat(600_000),
          choices: [],
          allowCustom: true,
          createdAt: Date.now(),
        },
      }),
    ).toBe(true);
    const frame = JSON.parse(String(write.mock.calls[0]?.[0])) as {
      event: { interaction: { question: string } };
    };
    expect(frame.event.interaction.question).toHaveLength(20_000);
    client.stop();
  });

  it('normalizes oversized interactions to values accepted by the shared schema', () => {
    const client = new BridgeClient({
      socketPath: '/unused',
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      handleCommand: async () => ({ accepted: true }),
    });
    const socket = new net.Socket();
    const write = vi.spyOn(socket, 'write').mockReturnValue(true);
    Reflect.set(client, 'socket', socket);
    expect(
      client.sendEvent({
        type: 'interaction.requested',
        interaction: {
          id: 'i'.repeat(400),
          type: 'ask_user',
          question: 'q'.repeat(150_000),
          choices: Array.from({ length: 200 }, (_, index) => ({
            label: `l${index}`.repeat(1_000),
            value: `v${index}`.repeat(1_000),
            description: 'd'.repeat(20_000),
            preview: 'p'.repeat(150_000),
          })),
          allowCustom: true,
          customLabel: 'c'.repeat(2_000),
          createdAt: Date.now(),
        },
      }),
    ).toBe(true);
    const frame = parseFrame(String(write.mock.calls[0]?.[0]));
    if (frame.kind !== 'event' || frame.event.type !== 'interaction.requested')
      throw new Error('expected interaction event');
    expect(frame.event.interaction.question).toHaveLength(20_000);
    expect(frame.event.interaction.choices).toHaveLength(50);
    expect(frame.event.interaction.choices[0]?.description).toHaveLength(2_000);
    expect(frame.event.interaction.choices[0]?.preview).toHaveLength(4_000);
    client.stop();
  });

  it('reconnects rather than silently dropping an interaction on backpressure', () => {
    const client = new BridgeClient({
      socketPath: '/unused',
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      handleCommand: async () => ({ accepted: true }),
    });
    const socket = new net.Socket();
    const write = vi.spyOn(socket, 'write').mockReturnValue(false);
    const destroy = vi.spyOn(socket, 'destroy');
    Reflect.set(client, 'socket', socket);
    expect(client.sendEvent({ type: 'runtime.heartbeat', state: 'idle' })).toBe(
      true,
    );
    expect(write).toHaveBeenCalledOnce();
    for (let index = 0; index < 128; index += 1)
      client.sendEvent({ type: 'runtime.stateChanged', state: 'idle' });
    expect(
      client.sendEvent({
        type: 'interaction.requested',
        interaction: {
          id: 'interaction-backpressure',
          type: 'ask_user',
          question: 'Still there?',
          choices: [],
          allowCustom: true,
          createdAt: Date.now(),
        },
      }),
    ).toBe(false);
    expect(destroy).toHaveBeenCalled();
    client.stop();
  });

  it('skips cyclic and oversized event payloads without closing the bridge', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'pi-bridge-payload-limit-'),
    );
    const socketPath = path.join(directory, 'bridge.sock');
    let connection: net.Socket | undefined;
    const received: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
      connection = socket;
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        for (const line of String(chunk).split('\n').filter(Boolean))
          received.push(JSON.parse(line) as Record<string, unknown>);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = new BridgeClient({
      socketPath,
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      handleCommand: async () => ({ accepted: true }),
    });
    client.start();
    await waitFor(() =>
      received.some(
        (frame) =>
          (frame.event as { type?: string } | undefined)?.type ===
          'runtime.hello',
      ),
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      client.sendEvent({
        type: 'message.started',
        sessionId: 'session-test',
        message: {
          messageId: 'cyclic-message',
          role: 'assistant',
          content: 'cyclic payload test',
          phase: 'started',
          data: cyclic,
        },
      }),
    ).toBe(true);
    expect(
      client.sendEvent({
        type: 'tool.finished',
        sessionId: 'session-test',
        tool: {
          toolCallId: 'oversized-tool',
          name: 'large-output',
          phase: 'finished',
          result: 'x'.repeat(600_000),
        },
      }),
    ).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connection?.destroyed).toBe(false);
    const nonHello = received.filter(
      (frame) =>
        (frame.event as { type?: string } | undefined)?.type !==
        'runtime.hello',
    );
    expect(nonHello).toHaveLength(1);
    expect(JSON.stringify(nonHello)).not.toContain('self');
    client.stop();
    connection?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('announces broker questions and resolves them through a daemon command', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'pi-bridge-broker-'),
    );
    const socketPath = path.join(directory, 'bridge.sock');
    const broker = new InteractionBroker();
    let connection: net.Socket | undefined;
    const seen: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
      connection = socket;
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          const frame = JSON.parse(line) as Record<string, unknown>;
          seen.push(frame);
          const event = frame.event as
            | { type?: string; interaction?: { id: string } }
            | undefined;
          if (event?.type === 'interaction.requested' && event.interaction)
            socket.write(
              serializeFrame({
                kind: 'command',
                command: {
                  id: 'answer-1',
                  type: 'interaction.answer',
                  interactionId: event.interaction.id,
                  answer: 'yes',
                },
              }),
            );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = new BridgeClient({
      socketPath,
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      broker,
      handleCommand: async (command) => {
        if (command.type === 'interaction.answer')
          broker.answer(command.interactionId, command.answer);
        return { accepted: true };
      },
    });
    client.start();
    await waitFor(() => Boolean(connection));
    const pending = broker.request(
      {
        type: 'ask_user',
        question: 'Continue?',
        choices: [{ label: 'Yes', value: 'yes' }],
        allowCustom: false,
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return null;
      },
    );
    await expect(pending).resolves.toMatchObject({
      answer: 'yes',
      choiceLabel: 'Yes',
    });
    await waitFor(() =>
      seen.some(
        (frame) =>
          (frame.event as { type?: string } | undefined)?.type ===
          'interaction.resolved',
      ),
    );
    client.stop();
    connection?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
});

describe('agent settlement', () => {
  it('keeps the dashboard working and suppresses settlement while a process is pending', () => {
    const source = {};
    const events: unknown[] = [];
    let currentSnapshot = { ...snapshot };
    const runtime = {
      isCurrent: () => true,
      setContext: () => undefined,
      setLiveState: (liveState: RuntimeSnapshot['liveState']) => {
        currentSnapshot = { ...currentSnapshot, liveState };
      },
      snapshot: () => currentSnapshot,
      client: { sendEvent: (event: unknown) => events.push(event) },
    } as unknown as Parameters<typeof emitAgentSettlement>[0];
    const ctx = {
      sessionManager: { getSessionId: () => 'session-test' },
    } as unknown as ExtensionContext;

    setPendingProcessCount(source, 1);
    try {
      emitAgentSettlement(runtime, ctx);
    } finally {
      setPendingProcessCount(source, 0);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'runtime.stateChanged',
        state: 'working',
        snapshot: expect.objectContaining({ liveState: 'working' }),
      }),
    ]);
  });
});
