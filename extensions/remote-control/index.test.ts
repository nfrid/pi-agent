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
import {
  type BridgeCommand,
  type RuntimeSnapshot,
  serializeFrame,
} from '@pi-dashboard/protocol';
import { describe, expect, it, vi } from 'vitest';
import { registerActivityGroupsCapability } from '../activity-groups/register-capability';
import { registerDelegateCapability } from '../delegate/register-capability';
import { beginsFreshUserTurn } from '../shared/runtime/agent-lifecycle';
import {
  getLiveExtensionSurfaceHub,
  LiveSurfaceHub,
} from '../shared/runtime/live-surfaces';
import { setPendingProcessCount } from '../shared/runtime/pending-processes';
import { registerTasksCapability } from '../tasks/register-capability';
import {
  BridgeClient,
  composerCommandsSnapshot,
  createRemoteControlRuntime,
  dispatchDashboardCommand,
  dispatchDashboardInput,
  emitAgentSettlement,
  emitCompactionCompleted,
  emitCompactionSettled,
  emitCompactionStarted,
  expandDashboardInput,
  flushQueueDrafts,
  isDroppableBridgeEvent,
  LiveEventNormalizer,
  modelCatalogSnapshot,
  QueueDraftStore,
  shouldForwardLiveMessage,
  shutdownRemoteControlRuntime,
  thinkingLevelsSnapshot,
  withoutOpaqueData,
} from './index';
import { emitTurnEnd } from './runtime';

registerActivityGroupsCapability();
registerDelegateCapability();
registerTasksCapability();

const snapshot: RuntimeSnapshot = {
  runtimeId: 'runtime-test',
  ownership: 'external',
  pid: 1,
  cwd: '/tmp',
  liveState: 'idle',
  session: { id: 'session-test', entries: [] },
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

describe('remote-control session lifecycle', () => {
  it('keeps raw argument delta updates non-droppable', () => {
    expect(
      isDroppableBridgeEvent({
        type: 'tool.updated',
        sessionId: 'session-test',
        tool: {
          toolCallId: 'call-1',
          name: 'write',
          argumentDelta: '{',
          status: 'pending',
          phase: 'updated',
        },
      }),
    ).toBe(false);
    expect(
      isDroppableBridgeEvent({
        type: 'tool.updated',
        sessionId: 'session-test',
        tool: {
          toolCallId: 'call-1',
          name: 'write',
          argumentPreview: '{',
          status: 'pending',
          phase: 'updated',
        },
      }),
    ).toBe(true);
  });
  it('publishes compaction progress and the saved completion entry', () => {
    const events: unknown[] = [];
    const runtime = {
      isCurrent: () => true,
      setContext: vi.fn(),
      setLiveState: vi.fn(),
      snapshotPatch: (
        _ctx: ExtensionContext,
        state: RuntimeSnapshot['liveState'],
        contextTokens?: number,
      ) => ({
        liveState: state,
        ...(contextTokens === undefined
          ? {}
          : {
              contextUsage: {
                tokens: contextTokens,
                contextWindow: 0,
                percent: null,
              },
            }),
      }),
      client: { sendEvent: (event: unknown) => events.push(event) },
    } as unknown as Parameters<typeof emitCompactionStarted>[0];
    const ctx = {
      cwd: '/tmp/project',
      isIdle: () => true,
      getContextUsage: () => undefined,
      sessionManager: {
        getSessionId: () => 'session-compact',
        getSessionFile: () => '/tmp/session-compact.jsonl',
        getSessionName: () => 'Compacted session',
        getCwd: () => '/tmp/project',
        getLeafId: () => 'compact-leaf',
        getBranch: () => [{ type: 'compaction', id: 'compact-leaf' }],
      },
    } as unknown as ExtensionContext;

    const compactionEntry = {
      type: 'compaction',
      id: 'compact-leaf',
      summary: 'Earlier context.',
    };
    emitCompactionStarted(runtime, ctx);
    emitCompactionCompleted(runtime, ctx, compactionEntry, 'manual');

    expect(events).toEqual([
      {
        type: 'runtime.stateChanged',
        state: 'compacting',
        snapshot: { liveState: 'compacting' },
      },
      {
        type: 'session.compacted',
        sessionId: 'session-compact',
        entry: compactionEntry,
      },
      {
        type: 'runtime.stateChanged',
        state: 'idle',
        snapshot: { liveState: 'idle' },
      },
    ]);
    expect(runtime.setContext).toHaveBeenCalled();
  });

  it.each([
    'new',
    'resume',
    'fork',
  ])('announces %s before stopping the old bridge when a replacement tears down its extension runtime', (reason) => {
    const sendEvent = vi.fn(() => true);
    const stop = vi.fn();
    const clearContext = vi.fn();
    const stopSteeringUpdates = vi.fn();
    const runtime = {
      client: { sendEvent, stop },
      isCurrent: () => true,
      clearContext,
      snapshot: () => snapshot,
    } as unknown as Parameters<typeof shutdownRemoteControlRuntime>[0];
    const ctx = {} as ExtensionContext;

    shutdownRemoteControlRuntime(runtime, { reason }, ctx, stopSteeringUpdates);

    expect(stopSteeringUpdates).toHaveBeenCalledOnce();
    expect(clearContext).toHaveBeenCalledWith(ctx);
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith({
      type: 'runtime.goodbye',
      reason,
    });
    expect(sendEvent.mock.invocationCallOrder[0]).toBeLessThan(
      stop.mock.invocationCallOrder[0],
    );
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(['quit', 'reload'])('announces %s and stops the bridge', (reason) => {
    const sendEvent = vi.fn(() => true);
    const stop = vi.fn();
    const runtime = {
      client: { sendEvent, stop },
      isCurrent: () => true,
      clearContext: vi.fn(),
      snapshot: () => snapshot,
    } as unknown as Parameters<typeof shutdownRemoteControlRuntime>[0];

    shutdownRemoteControlRuntime(
      runtime,
      { reason },
      {} as ExtensionContext,
      vi.fn(),
    );

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'runtime.goodbye',
      reason,
    });
    expect(stop).toHaveBeenCalledOnce();
  });
});

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

  it('expands ordered inline skill references and ignores escaped or code references', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-skills-'));
    const foo = path.join(directory, 'foo.md');
    const bar = path.join(directory, 'bar.md');
    await writeFile(foo, '---\nname: foo\n---\nFoo instructions.\n');
    await writeFile(bar, '---\nname: bar\n---\nBar instructions.\n');
    const sourceInfo = (file: string) => ({
      path: file,
      source: 'local' as const,
      scope: 'user' as const,
      origin: 'top-level' as const,
      baseDir: directory,
    });
    const expanded = expandDashboardInput(
      'use $foo and $bar with $foo again; keep \\$foo, `$bar`, and $unknown\n```\n$bar\n```',
      [
        { name: 'skill:foo', source: 'skill', sourceInfo: sourceInfo(foo) },
        { name: 'skill:bar', source: 'skill', sourceInfo: sourceInfo(bar) },
      ],
    );
    expect(expanded).toBe(
      `<skill name="foo" location="${foo}">\nReferences are relative to ${directory}.\n\nFoo instructions.\n</skill>\n\n` +
        `<skill name="bar" location="${bar}">\nReferences are relative to ${directory}.\n\nBar instructions.\n</skill>\n\n` +
        'use foo and bar with foo again; keep $foo, `$bar`, and $unknown\n```\n$bar\n```',
    );
    await rm(directory, { recursive: true, force: true });
  });

  it('expands inline skills after prompt-template substitution', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-prompt-skill-'));
    const prompt = path.join(directory, 'review.md');
    const skill = path.join(directory, 'foo.md');
    await writeFile(prompt, 'Review $ARGUMENTS');
    await writeFile(skill, '---\nname: foo\n---\nFoo instructions.\n');
    const sourceInfo = (file: string) => ({
      path: file,
      source: 'local' as const,
      scope: 'user' as const,
      origin: 'top-level' as const,
      baseDir: directory,
    });
    expect(
      expandDashboardInput('/review use $foo', [
        { name: 'review', source: 'prompt', sourceInfo: sourceInfo(prompt) },
        { name: 'skill:foo', source: 'skill', sourceInfo: sourceInfo(skill) },
      ]),
    ).toBe(
      `<skill name="foo" location="${skill}">\nReferences are relative to ${directory}.\n\nFoo instructions.\n</skill>\n\nReview use foo`,
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
      dispatchDashboardCommand(pi, context, {
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

    await dispatchDashboardInput(pi, context, 'fresh dashboard prompt');
    expect(sendUserMessage).toHaveBeenCalledWith(
      'fresh dashboard prompt',
      undefined,
    );
    expect(beginsFreshUserTurn({ source: 'extension' })).toBe(true);

    await dispatchDashboardInput(pi, context, 'later', 'followUp');
    expect(sendUserMessage).toHaveBeenCalledWith('later', {
      deliverAs: 'followUp',
    });
  });

  it('updates the Codex service tier with the existing model command', async () => {
    const appendEntry = vi.fn();
    const emit = vi.fn();
    const model = { provider: 'openai-codex', id: 'gpt' };
    const pi = {
      setModel: vi.fn(async () => true),
      appendEntry,
      events: { emit },
    } as unknown as ExtensionAPI;
    const context = {
      model,
      modelRegistry: { find: () => model },
      sessionManager: {},
    } as unknown as ExtensionContext;

    await dispatchDashboardCommand(pi, context, {
      id: 'model-fast',
      type: 'setModel',
      provider: 'openai-codex',
      model: 'gpt',
      serviceTier: 'fast',
    });
    expect(appendEntry).toHaveBeenLastCalledWith('codex-service-tier', {
      tier: 'fast',
    });
    await dispatchDashboardCommand(pi, context, {
      id: 'model-preserve',
      type: 'setModel',
      provider: 'openai-codex',
      model: 'gpt',
    });
    expect(appendEntry).toHaveBeenCalledTimes(1);
    await dispatchDashboardCommand(pi, context, {
      id: 'model-normal',
      type: 'setModel',
      provider: 'openai-codex',
      model: 'gpt',
      serviceTier: null,
    });
    expect(appendEntry).toHaveBeenLastCalledWith('codex-service-tier', {
      tier: null,
    });
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('dispatches pause and continue immediately even in steering mode', async () => {
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const pi = {
      events: {
        on: vi.fn(),
        emit(event: string, value: unknown) {
          for (const listener of listeners.get(event) ?? []) listener(value);
        },
      },
    } as unknown as ExtensionAPI;
    const context = {
      isIdle: () => false,
      sessionManager: { getSessionId: () => 'dashboard-pause' },
    } as unknown as ExtensionContext;

    await expect(
      dispatchDashboardInput(pi, context, '/pause', 'steer'),
    ).resolves.toMatchObject({ command: 'pause' });
    await expect(
      dispatchDashboardInput(pi, context, '/continue', 'steer'),
    ).resolves.toMatchObject({ command: 'continue' });
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
    expect(
      shouldForwardLiveMessage({
        message: {
          role: 'custom',
          content: 'hidden direct context',
          display: false,
        },
      }),
    ).toBe(false);
    expect(
      shouldForwardLiveMessage({
        message: {
          role: 'custom',
          content: 'hidden nested context',
          data: { display: false },
        },
      }),
    ).toBe(false);
    expect(
      shouldForwardLiveMessage({
        message: {
          role: 'custom',
          content:
            'Todo state at the start of this user turn (0 active, 0 ready, 0 blocked, 0 done).',
        },
      }),
    ).toBe(false);
  });

  it('preserves safe custom-message metadata for live transcript formatting', () => {
    const normalizer = new LiveEventNormalizer('runtime-custom');
    const message = normalizer.normalizeMessage('finished', {
      message: {
        role: 'custom',
        customType: 'delegate-job-result',
        content: '# Background delegate job dj-1 (Review) success',
        display: true,
        details: { jobs: [{ name: 'Review', state: 'success' }] },
      },
    });

    expect(message).toMatchObject({
      role: 'custom',
      data: {
        customType: 'delegate-job-result',
        display: true,
        details: { jobs: [{ name: 'Review', state: 'success' }] },
      },
    });
    expect(
      normalizer.normalizeMessage('finished', {
        message: {
          role: 'custom',
          content: 'nested metadata',
          data: {
            customType: 'nested-note',
            display: false,
            details: { source: 'context' },
          },
        },
      }),
    ).toMatchObject({
      role: 'custom',
      data: {
        customType: 'nested-note',
        display: false,
        details: { source: 'context' },
      },
    });
    const combinedMetadata = {
      customType: 'delegate-job-result',
      display: true,
      details: { jobs: [{ name: 'Review', state: 'success' }] },
      deliveryMode: 'steer' as const,
    };
    expect(
      withoutOpaqueData({
        type: 'message.finished',
        sessionId: 'session-test',
        message: { ...message, data: combinedMetadata },
      }),
    ).toMatchObject({ message: { data: combinedMetadata } });
    expect(
      withoutOpaqueData({
        type: 'message.updated',
        sessionId: 'session-test',
        message: { ...message, phase: 'updated', data: { display: false } },
      }),
    ).toMatchObject({ message: { data: { display: false } } });
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

  it('normalizes provisional tool-call chunks without cumulative deltas', () => {
    const normalizer = new LiveEventNormalizer('runtime-tool-progress');
    const partial = {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'call-1', name: 'write', arguments: {} },
      ],
    };
    expect(
      normalizer.normalizeToolCall({
        type: 'toolcall_start',
        contentIndex: 0,
        id: 'call-1',
        toolName: 'write',
      }),
    ).toMatchObject([
      { toolCallId: 'call-1', name: 'write', phase: 'started' },
    ]);
    expect(
      normalizer.normalizeToolCall({
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: 'x',
        partial,
      }),
    ).toEqual([]);
    expect(
      normalizer.normalizeToolCall({
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: 'y',
        partial,
      }),
    ).toEqual([]);
    const chunks = normalizer.normalizeToolCall({
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: 'z'.repeat(4_094),
      partial,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.argumentDelta).toHaveLength(4_096);
    expect(chunks[0]?.argumentChars).toBe(4_096);
    expect(chunks[0]).not.toHaveProperty('argumentPreview');
    const tail = normalizer.normalizeToolCall({
      type: 'toolcall_end',
      contentIndex: 0,
      partial,
    });
    expect(tail).toEqual([]);
    const tailNormalizer = new LiveEventNormalizer('runtime-tool-tail');
    tailNormalizer.normalizeToolCall({
      type: 'toolcall_start',
      contentIndex: 0,
      partial,
    });
    tailNormalizer.normalizeToolCall({
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: 'tail',
      partial,
    });
    expect(
      tailNormalizer.normalizeToolCall({
        type: 'toolcall_end',
        contentIndex: 0,
        partial,
      }),
    ).toMatchObject([
      { argumentDelta: 'tail', argumentChars: 4, argumentLines: 1 },
    ]);
  });

  it('counts escaped newlines across chunks without counting literal backslashes', () => {
    const normalizer = new LiveEventNormalizer('runtime-tool-lines');
    const partial = {
      content: [{ type: 'toolCall', id: 'call-lines', name: 'write' }],
    };
    normalizer.normalizeToolCall({
      type: 'toolcall_start',
      contentIndex: 0,
      partial,
    });
    normalizer.normalizeToolCall({
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: '{"content":"a\\',
      partial,
    });
    normalizer.normalizeToolCall({
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: 'n"}',
      partial,
    });
    expect(
      normalizer.normalizeToolCall({
        type: 'toolcall_end',
        contentIndex: 0,
        partial,
      }),
    ).toMatchObject([{ argumentLines: 2 }]);

    const literal = new LiveEventNormalizer('runtime-tool-literal-slash');
    literal.normalizeToolCall({
      type: 'toolcall_start',
      contentIndex: 0,
      partial,
    });
    literal.normalizeToolCall({
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: '{"content":"a\\\\',
      partial,
    });
    literal.normalizeToolCall({
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: 'n"}',
      partial,
    });
    expect(
      literal.normalizeToolCall({
        type: 'toolcall_end',
        contentIndex: 0,
        partial,
      }),
    ).toMatchObject([{ argumentLines: 1 }]);
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

  it('publishes completed thinking lines while retaining the partial tail', () => {
    const normalizer = new LiveEventNormalizer('runtime-thinking');
    normalizer.normalizeMessage('started', {
      message: { role: 'assistant', content: [] },
    });
    normalizer.normalizeMessage('updated', {
      assistantMessageEvent: {
        type: 'thinking_start',
        contentIndex: 0,
      },
    });

    expect(
      normalizer.normalizeMessage('updated', {
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: '**Inspect',
        },
      }).content,
    ).toEqual([]);
    expect(
      normalizer.normalizeMessage('updated', {
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'ing the runtime**\n**Checking',
        },
      }).content,
    ).toEqual([{ type: 'thinking', thinking: '**Inspecting the runtime**\n' }]);
    expect(
      normalizer.normalizeMessage('updated', {
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: ' tests**\nUnfinished',
        },
      }).content,
    ).toEqual([
      {
        type: 'thinking',
        thinking: '**Inspecting the runtime**\n**Checking tests**\n',
      },
    ]);
    expect(
      normalizer.normalizeMessage('updated', {
        assistantMessageEvent: {
          type: 'thinking_end',
          contentIndex: 0,
          content:
            '**Inspecting the runtime**\n**Checking tests**\nUnfinished title',
        },
      }).content,
    ).toEqual([
      {
        type: 'thinking',
        thinking:
          '**Inspecting the runtime**\n**Checking tests**\nUnfinished title',
      },
    ]);
  });

  it('uses Pi toolCallId and preserves direct tool execution fields', () => {
    const normalizer = new LiveEventNormalizer('runtime-epoch');
    expect(
      normalizer.normalizeTool('started', {
        toolCallId: 'read-1',
        toolName: 'read',
        args: { path: '/tmp/file' },
        timestamp: 100,
      }),
    ).toMatchObject({
      toolCallId: 'read-1',
      name: 'read',
      arguments: { path: '/tmp/file' },
      timestamp: 100,
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
  it('derives stable external ownership without requiring a managed launch token', () => {
    const previousManaged = process.env.PI_DASHBOARD_RUNTIME_ID;
    const previousExternal = process.env.PI_DASHBOARD_EXTERNAL_RUNTIME_ID;
    try {
      delete process.env.PI_DASHBOARD_RUNTIME_ID;
      process.env.PI_DASHBOARD_EXTERNAL_RUNTIME_ID = 'host-job-runtime';
      const external = createRemoteControlRuntime({} as ExtensionAPI);
      expect(external?.runtimeId).toBe('host-job-runtime');
      expect(external?.snapshot()).toMatchObject({ ownership: 'external' });

      process.env.PI_DASHBOARD_RUNTIME_ID = 'managed-runtime';
      process.env.PI_DASHBOARD_EXTERNAL_RUNTIME_ID = 'ignored-external';
      const managed = createRemoteControlRuntime({} as ExtensionAPI);
      expect(managed?.runtimeId).toBe('managed-runtime');
      expect(managed?.snapshot()).toMatchObject({ ownership: 'managed' });
    } finally {
      if (previousManaged === undefined)
        delete process.env.PI_DASHBOARD_RUNTIME_ID;
      else process.env.PI_DASHBOARD_RUNTIME_ID = previousManaged;
      if (previousExternal === undefined)
        delete process.env.PI_DASHBOARD_EXTERNAL_RUNTIME_ID;
      else process.env.PI_DASHBOARD_EXTERNAL_RUNTIME_ID = previousExternal;
    }
  });

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
        { name: 'bad name', source: 'prompt' },
        { name: 'bad/name', source: 'prompt' },
        { name: ' padded ', source: 'prompt' },
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
    expect(commands).not.toContainEqual(
      expect.objectContaining({ name: 'bad name' }),
    );
    expect(commands).not.toContainEqual(
      expect.objectContaining({ name: 'bad/name' }),
    );
    expect(commands).not.toContainEqual(
      expect.objectContaining({ name: 'padded' }),
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
      contextWindow: 272_000,
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
        contextWindow: 272_000,
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

  it('owns queued image bytes while exposing metadata-only snapshots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'queue-image-'));
    const file = path.join(root, 'image.png');
    await writeFile(file, Buffer.from([1, 2, 3]));
    const store = new QueueDraftStore();
    store.setSession('session-image');
    store.add({
      id: 'command-image',
      type: 'queue.add',
      clientId: 'draft-image',
      mode: 'steer',
      text: '',
      images: [{ type: 'image', path: file, mediaType: 'image/png' }],
    });
    await rm(file);

    expect(store.list()).toEqual([
      {
        clientId: 'draft-image',
        mode: 'steer',
        text: '',
        imageCount: 1,
      },
    ]);
    const [owned] = store.take('steer');
    expect(owned?.images).toEqual([
      { type: 'image', data: 'AQID', mimeType: 'image/png' },
    ]);
    await rm(root, { recursive: true, force: true });
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

  const turnEndContext = (
    sessionId: string,
    usage: NonNullable<RuntimeSnapshot['contextUsage']>,
  ) =>
    ({
      cwd: '/tmp',
      model: undefined,
      thinkingLevel: 'off',
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => sessionId,
        getSessionFile: () => undefined,
        getSessionName: () => undefined,
        getCwd: () => '/tmp',
        getLeafId: () => undefined,
      },
      getContextUsage: () => usage,
      isIdle: () => false,
    }) as unknown as ExtensionContext;

  it('keeps automatic compaction in the working lifecycle', () => {
    const runtime = createRemoteControlRuntime({} as ExtensionAPI);
    if (!runtime) throw new Error('runtime was not created');
    const context = turnEndContext('session-compaction-context', {
      tokens: null,
      contextWindow: 100_000,
      percent: null,
    });
    runtime.setContext(context);
    const sendEvent = vi.spyOn(runtime.client, 'sendEvent');

    emitCompactionSettled(runtime, context, 'threshold');

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'runtime.stateChanged',
      state: 'working',
      snapshot: expect.objectContaining({ liveState: 'working' }),
    });
    expect(runtime.snapshot().liveState).toBe('working');
    runtime.clearContext(context);
  });

  it('publishes context usage at turn_end while the agent remains working', () => {
    const runtime = createRemoteControlRuntime({} as ExtensionAPI);
    if (!runtime) throw new Error('runtime was not created');
    const context = turnEndContext('session-turn-end-context', {
      tokens: 12_345,
      contextWindow: 100_000,
      percent: 12.345,
    });
    runtime.setContext(context);
    const sendEvent = vi.spyOn(runtime.client, 'sendEvent');

    emitTurnEnd(runtime, {} as ExtensionAPI, context);

    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith({
      type: 'runtime.stateChanged',
      state: 'working',
      snapshot: expect.objectContaining({
        liveState: 'working',
        contextUsage: {
          tokens: 12_345,
          contextWindow: 100_000,
          percent: 12.345,
        },
      }),
    });
    runtime.clearContext(context);
  });

  it('refreshes context usage after delivering a steer draft', () => {
    const sendUserMessage = vi.fn();
    const runtime = createRemoteControlRuntime({} as ExtensionAPI);
    if (!runtime) throw new Error('runtime was not created');
    const context = turnEndContext('session-turn-end-steer', {
      tokens: 23_456,
      contextWindow: 100_000,
      percent: 23.456,
    });
    runtime.setContext(context);
    runtime.queueDrafts.add({
      clientId: 'steer-turn-end',
      mode: 'steer',
      text: 'steer me',
    });
    const sendEvent = vi.spyOn(runtime.client, 'sendEvent');

    emitTurnEnd(
      runtime,
      { sendUserMessage } as unknown as ExtensionAPI,
      context,
    );

    expect(sendUserMessage).toHaveBeenCalledWith('steer me', {
      deliverAs: 'steer',
    });
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith({
      type: 'runtime.stateChanged',
      state: 'working',
      snapshot: expect.objectContaining({
        contextUsage: {
          tokens: 23_456,
          contextWindow: 100_000,
          percent: 23.456,
        },
      }),
    });
    runtime.clearContext(context);
  });

  it('expands queued prompt templates before Pi delivery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-queue-template-'));
    const file = path.join(root, 'review.md');
    await writeFile(file, 'Review $1 carefully.');
    try {
      const sendUserMessage = vi.fn();
      const runtime = createRemoteControlRuntime({} as ExtensionAPI);
      if (!runtime) throw new Error('runtime was not created');
      const context = {
        cwd: root,
        model: undefined,
        thinkingLevel: 'off',
        sessionManager: {
          getBranch: () => [],
          getSessionId: () => 'session-template-queue',
          getSessionFile: () => undefined,
          getSessionName: () => undefined,
          getCwd: () => root,
          getLeafId: () => undefined,
        },
        getContextUsage: () => undefined,
        isIdle: () => false,
      } as unknown as ExtensionContext;
      runtime.setContext(context);
      runtime.queueDrafts.add({
        clientId: 'queued-template',
        mode: 'followUp',
        text: '/review src',
      });
      flushQueueDrafts(
        runtime,
        {
          getCommands: () => [
            {
              name: 'review',
              description: 'Review code',
              source: 'prompt',
              sourceInfo: {
                path: file,
                source: 'test',
                scope: 'temporary',
                origin: 'top-level',
              },
            },
          ],
          sendUserMessage,
        } as unknown as ExtensionAPI,
        context,
        'followUp',
      );
      expect(sendUserMessage).toHaveBeenCalledWith('Review src carefully.', {
        deliverAs: 'followUp',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it('requests usage after hello and resolves the daemon acknowledgement', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-usage-bridge-'));
    const socketPath = path.join(directory, 'bridge.sock');
    const received: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += String(chunk);
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            const frame = JSON.parse(line) as Record<string, unknown>;
            received.push(frame);
            if (
              frame.kind === 'event' &&
              (frame.event as { type?: string }).type === 'runtime.hello'
            ) {
              socket.write(
                serializeFrame({
                  kind: 'ready',
                  capabilities: { usageRead: true },
                }),
              );
            } else if (frame.kind === 'request') {
              const request = frame.request as { id: string };
              socket.write(
                serializeFrame({
                  kind: 'ack',
                  id: request.id,
                  ok: true,
                  result: {
                    usage: { capturedAt: 123, snapshots: [] },
                  },
                }),
              );
            }
          }
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
    await expect(client.requestUsage(true)).resolves.toEqual({
      usage: { capturedAt: 123, snapshots: [] },
    });
    expect(
      received.map((frame) =>
        frame.kind === 'event'
          ? (frame.event as { type: string }).type
          : (frame.request as { type: string }).type,
      ),
    ).toEqual(['runtime.hello', 'usage.read']);

    client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('falls back cleanly without disconnecting from an older daemon', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-usage-legacy-'));
    const socketPath = path.join(directory, 'bridge.sock');
    const received: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
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
    await waitFor(() => received.length > 0);
    vi.useFakeTimers();
    try {
      const rejection = expect(client.requestUsage()).rejects.toThrow(
        'Dashboard daemon does not advertise usage reads.',
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(
        client.sendEvent({
          type: 'session.snapshot',
          session: snapshot.session,
        }),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }

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
    const largeBranch = [
      {
        type: 'message',
        message: { role: 'user', content: '  inspect   title  ' },
      },
      ...Array.from({ length: 512 }, (_, index) => ({
        type: 'message',
        id: `large-entry-${index}`,
        message: {
          role: 'assistant',
          content: 'large branch entry '.repeat(32),
        },
      })),
    ];
    const manager = {
      getBranch: () => active(largeBranch),
      getSessionId: () => active('session-current'),
      getSessionFile: () => active('/tmp/session.jsonl'),
      getSessionName: () => active('Current session'),
      getCwd: () => active('/tmp/project'),
      getLeafId: () => active(undefined as string | undefined),
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
    const fullSnapshotBytes = JSON.stringify(
      runtime?.snapshot() ?? snapshot,
    ).length;
    const branchReadsBeforePatch = manager.getBranch;
    let routineBranchReads = 0;
    manager.getBranch = () => {
      routineBranchReads += 1;
      return branchReadsBeforePatch();
    };
    const routinePatch = runtime?.snapshotPatch?.(context, 'working');
    expect(routineBranchReads).toBe(0);
    expect(routinePatch).toMatchObject({
      online: true,
      lastSeenAt: expect.any(Number),
      session: {
        id: 'session-current',
        file: '/tmp/session.jsonl',
        name: 'Current session',
        title: 'inspect title',
        cwd: '/tmp/project',
        entries: [],
        entriesComplete: false,
      },
    });
    expect(routinePatch?.session).not.toHaveProperty('leafId');
    expect(JSON.stringify(routinePatch)).not.toContain('large-entry-');
    expect(JSON.stringify(routinePatch)).not.toContain('large branch entry');
    expect(runtime?.snapshot().session.entries).toEqual([]);
    expect(runtime?.snapshot().session.entriesComplete).toBe(false);
    const patchClient = new BridgeClient({
      socketPath: '/unused',
      runtimeId: 'runtime-test',
      snapshot: () => runtime?.snapshot() ?? snapshot,
      handleCommand: async () => ({ accepted: true }),
    });
    const patchSocket = new net.Socket();
    const patchWrite = vi.spyOn(patchSocket, 'write').mockReturnValue(true);
    Reflect.set(patchClient, 'socket', patchSocket);
    expect(
      patchClient.sendEvent({
        type: 'runtime.stateChanged',
        state: 'working',
        snapshot: routinePatch,
      }),
    ).toBe(true);
    const routineFrame = JSON.parse(String(patchWrite.mock.calls[0]?.[0])) as {
      event: { snapshot?: Record<string, unknown> };
    };
    expect(routineFrame.event.snapshot?.session).toMatchObject({
      id: 'session-current',
      entries: [],
      entriesComplete: false,
    });
    expect(routineFrame.event.snapshot?.session).not.toHaveProperty('leafId');
    expect(String(patchWrite.mock.calls[0]?.[0])).not.toContain('large-entry-');
    expect(String(patchWrite.mock.calls[0]?.[0])).not.toContain(
      'large branch entry',
    );
    expect(String(patchWrite.mock.calls[0]?.[0]).length).toBeLessThan(
      fullSnapshotBytes,
    );
    patchClient.stop();
    manager.getLeafId = () => 'current-leaf';
    const patchWithCurrentLeaf = runtime?.snapshotPatch?.(context, 'idle');
    expect(routineBranchReads).toBe(0);
    expect(patchWithCurrentLeaf?.session).toMatchObject({
      entries: [],
      entriesComplete: false,
      leafId: 'current-leaf',
    });
    manager.getLeafId = () => 'x'.repeat(256);
    expect(
      runtime?.snapshotPatch?.(context, 'idle').session?.leafId,
    ).toHaveLength(256);
    manager.getLeafId = () => 'x'.repeat(257);
    expect(
      runtime?.snapshotPatch?.(context, 'idle').session,
    ).not.toHaveProperty('leafId');
    expect(routineBranchReads).toBe(0);
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

  it('keeps reconnect hello compact and replays active delegate entries after it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-bridge-'));
    const socketPath = path.join(directory, 'bridge.sock');
    const received: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        for (const line of String(chunk).split('\n').filter(Boolean))
          received.push(JSON.parse(line) as Record<string, unknown>);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const hub = new LiveSurfaceHub();
    hub.publish('delegate', [
      {
        id: 'delegate.status',
        rendererId: 'delegate.status',
        viewModel: {
          version: 1,
          statuses: [
            {
              id: 'ds-1',
              runId: 'run-1',
              lineageId: 'lineage-1',
              name: 'Worker',
              kind: 'background',
              state: 'running',
              createdAt: 1,
              allowWrites: false,
              transcript: [
                {
                  id: 'task',
                  type: 'task',
                  label: 'Task',
                  text: 'inspect source',
                  status: 'completed',
                },
                {
                  id: 'tool-1',
                  type: 'tool',
                  label: 'read source',
                  status: 'completed',
                },
              ],
            },
            {
              id: 'ds-hosted',
              runId: 'run-hosted',
              sessionId: 'child-session-1',
              lineageId: 'lineage-hosted',
              name: 'Hosted worker',
              kind: 'background',
              state: 'running',
              createdAt: 1,
              allowWrites: false,
              transcript: [
                {
                  id: 'hosted-tool',
                  type: 'tool',
                  label: 'read child source',
                  status: 'completed',
                },
              ],
            },
          ],
        },
      },
    ]);
    const client = new BridgeClient({
      socketPath,
      runtimeId: 'runtime-test',
      snapshot: () => snapshot,
      liveSurfaces: hub,
      handleCommand: async (command) => ({ type: command.type }),
    });
    client.start();
    await waitFor(() =>
      received.some(
        (frame) =>
          (frame.event as { type?: string } | undefined)?.type ===
          'delegate.transcript.updated',
      ),
    );
    const hello = received.find(
      (frame) =>
        (frame.event as { type?: string } | undefined)?.type ===
        'runtime.hello',
    );
    expect(JSON.stringify(hello)).not.toContain('transcript');
    const replay = received.filter(
      (frame) =>
        (frame.event as { type?: string } | undefined)?.type ===
        'delegate.transcript.updated',
    );
    expect(replay).toHaveLength(2);
    expect(
      replay.map(
        (frame) => (frame.event as { entry: { id: string } }).entry.id,
      ),
    ).toEqual(['task', 'tool-1']);
    expect(JSON.stringify(replay)).not.toContain('hosted-tool');
    expect(
      received.findIndex(
        (frame) =>
          (frame.event as { type?: string } | undefined)?.type ===
          'runtime.hello',
      ),
    ).toBeLessThan(
      received.findIndex(
        (frame) =>
          (frame.event as { type?: string } | undefined)?.type ===
          'delegate.transcript.updated',
      ),
    );
    client.stop();
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
    hub.publish('pause', [
      {
        id: 'runtime.pause-status',
        rendererId: 'runtime.pause-status',
        viewModel: {
          version: 1,
          phase: 'pausing',
          delegateCount: 0,
          label: 'Pausing…',
        },
      },
    ]);
    hub.publish('pause', [
      {
        id: 'runtime.pause-status',
        rendererId: 'runtime.pause-status',
        viewModel: {
          version: 1,
          phase: 'paused',
          delegateCount: 0,
          pausedAt: 12_345,
          label: 'Paused',
        },
      },
    ]);
    const frames = write.mock.calls.map(
      (call) =>
        JSON.parse(String(call[0])) as {
          event: { type: string; snapshot?: RuntimeSnapshot };
        },
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]?.event).toMatchObject({
      type: 'runtime.stateChanged',
      snapshot: {
        extensionSurfaces: [
          { viewModel: { phase: 'pausing', label: 'Pausing…' } },
        ],
      },
    });
    expect(frames[1]?.event).toMatchObject({
      type: 'runtime.stateChanged',
      snapshot: {
        extensionSurfaces: [
          { viewModel: { phase: 'paused', pausedAt: 12_345, label: 'Paused' } },
        ],
      },
    });
    client.stop();
    hub.publish('tasks', []);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('streams delegate transcript upserts without repeating unchanged metadata', () => {
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
    const publish = (text?: string) =>
      hub.publish('delegate', [
        {
          id: 'delegate.status',
          rendererId: 'delegate.status',
          viewModel: {
            version: 1,
            statuses: [
              {
                id: 'ds-1',
                runId: 'run-1',
                lineageId: 'lineage-1',
                name: 'Worker',
                kind: 'background',
                state: 'running',
                createdAt: 1,
                allowWrites: false,
                transcript: [
                  {
                    id: 'tool-1',
                    type: 'tool',
                    label: 'read source.ts',
                    name: 'read',
                    status: 'running',
                    ...(text ? { text } : {}),
                  },
                ],
                result: {
                  kind: 'structured',
                  status: 'valid',
                  value: { secret: 'must be omitted' },
                },
              },
            ],
          },
        },
      ]);
    publish();
    let frames = write.mock.calls.map(
      (call) =>
        JSON.parse(String(call[0])) as {
          event: Record<string, unknown>;
        },
    );
    expect(frames[0]?.event).toMatchObject({
      type: 'runtime.stateChanged',
      snapshot: {
        extensionSurfaces: [
          {
            viewModel: {
              statuses: [{ result: { valueOmitted: true } }],
            },
          },
        ],
      },
    });
    expect(JSON.stringify(frames[0]?.event)).not.toContain(
      'transcriptTruncated',
    );
    expect(frames[1]?.event).toMatchObject({
      type: 'delegate.transcript.updated',
      sessionId: 'session-test',
      lineageId: 'lineage-1',
      runId: 'run-1',
      entry: { id: 'tool-1', status: 'running' },
    });

    publish('new transcript text');
    frames = write.mock.calls.map(
      (call) =>
        JSON.parse(String(call[0])) as {
          event: Record<string, unknown>;
        },
    );
    expect(frames).toHaveLength(3);
    expect(frames[2]?.event).toMatchObject({
      type: 'delegate.transcript.updated',
      entry: { id: 'tool-1', text: 'new transcript text' },
    });
    client.stop();
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
      actionId: 'runtime.abort',
      input: {},
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
});

describe('agent settlement', () => {
  it('publishes compact waiting state while a process is pending', () => {
    const scope = `session-settled-${Date.now()}`;
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
      isIdle: () => true,
      sessionManager: { getSessionId: () => scope },
    } as unknown as ExtensionContext;

    setPendingProcessCount(source, 2, scope);
    try {
      emitAgentSettlement(runtime, ctx);
      expect(getLiveExtensionSurfaceHub(scope).snapshot()).toEqual([
        expect.objectContaining({
          rendererId: 'runtime.settled-background',
          viewModel: { version: 1, count: 2 },
        }),
      ]);
    } finally {
      setPendingProcessCount(source, 0, scope);
      getLiveExtensionSurfaceHub(scope).clear('remote-control');
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
