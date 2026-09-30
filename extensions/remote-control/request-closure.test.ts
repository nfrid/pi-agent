import { describe, expect, it } from 'vitest';
import {
  installRequestClosureBoundary,
  RequestClosureLifecycle,
} from './request-closure';

function setup() {
  const lifecycle = new RequestClosureLifecycle();
  const user = { role: 'user', timestamp: 10, content: 'request' };
  const answer = { role: 'assistant', timestamp: 20, content: 'answer' };
  const branch: Array<Record<string, unknown>> = [
    {
      type: 'message',
      id: 'user-entry',
      timestamp: new Date(10).toISOString(),
      message: user,
    },
    {
      type: 'message',
      id: 'assistant-entry',
      timestamp: new Date(20).toISOString(),
      message: answer,
    },
  ];
  const ctx = {
    sessionManager: {
      getSessionId: () => 'session',
      getBranch: () => branch,
    },
  } as never;
  const event = {
    outcome: 'completed',
    entries: [],
    context: { pendingMessages: [] },
  } as never;
  lifecycle.observe('session', user);
  lifecycle.observeLiveAlias(user, 'live-user');
  lifecycle.observe('session', answer);
  lifecycle.observeLiveAlias(answer, 'live-answer');
  const appendEntry = (customType: string, data: unknown) => {
    branch.push({
      type: 'custom',
      id: 'marker-entry',
      parentId: 'assistant-entry',
      timestamp: new Date(21).toISOString(),
      customType,
      data,
    });
  };
  const settle = () => {
    lifecycle.beforeSettle(event, ctx);
    return lifecycle.persistedMarker(ctx, appendEntry);
  };
  return { lifecycle, ctx, event, user, branch, appendEntry, settle };
}

describe('request closure lifecycle', () => {
  it('binds exact persisted entries and live aliases at final settlement', () => {
    const { settle } = setup();
    expect(settle()).toMatchObject({
      id: 'marker-entry',
      type: 'custom',
      customType: 'response-closure',
      data: {
        requestMessageId: 'user-entry',
        finalMessageId: 'assistant-entry',
        startedAt: 10,
        endedAt: 20,
        liveRequestMessageId: 'live-user',
        liveFinalMessageId: 'live-answer',
      },
    });
  });

  it('does not persist a provisional marker at a continuing boundary', () => {
    const { lifecycle, ctx, event, appendEntry, branch } = setup();
    const continuing = event as { continue: boolean };
    continuing.continue = true;
    lifecycle.beforeSettle(event, ctx);
    expect(lifecycle.persistedMarker(ctx, appendEntry)).toBeUndefined();
    expect(
      branch.some((entry) => entry.customType === 'response-closure'),
    ).toBe(false);
  });

  it('fails closed when native message identity is missing or ambiguous', () => {
    const missing = setup();
    missing.branch.pop();
    expect(
      missing.lifecycle.beforeSettle(missing.event, missing.ctx),
    ).toBeUndefined();
    const ambiguous = setup();
    const firstEntry = ambiguous.branch[0];
    if (firstEntry) ambiguous.branch.push({ ...firstEntry });
    expect(
      ambiguous.lifecycle.beforeSettle(ambiguous.event, ambiguous.ctx),
    ).toBeUndefined();
  });

  it('keeps the request open for a named process or watch until its exact result enters context', () => {
    const { lifecycle, ctx, event, appendEntry } = setup();
    lifecycle.wait(
      [
        { kind: 'process', id: 'job' },
        { kind: 'watch', id: 'job', watchId: 'ready' },
      ],
      new Map(),
      [],
    );
    expect(lifecycle.beforeSettle(event, ctx)).toBeUndefined();
    expect(lifecycle.persistedMarker(ctx, appendEntry)).toBeUndefined();
    expect(lifecycle.beforeSettle(event, ctx)).toBeUndefined();
    lifecycle.entered([
      {
        role: 'custom',
        customType: 'background-watch-result',
        details: {
          id: 'job',
          watchId: 'ready',
          dedupeKey: 'job:ready',
          status: 'timed_out',
        },
      },
    ]);
    expect(lifecycle.beforeSettle(event, ctx)).toBeUndefined();
    lifecycle.entered([
      {
        role: 'custom',
        customType: 'background-terminal-result',
        details: {
          id: 'job',
          dedupeKey: 'job',
          status: 'done',
          endedWatches: [{ id: 'ready', contains: 'READY' }],
        },
      },
    ]);
    lifecycle.beforeSettle(event, ctx);
    expect(lifecycle.persistedMarker(ctx, appendEntry)).toMatchObject({
      customType: 'response-closure',
      data: { requestMessageId: 'user-entry' },
    });
  });

  it('validates all targets from persisted start receipts and canonicalizes delegate identities', async () => {
    const { lifecycle, ctx, event, appendEntry } = setup();
    const tools = new Map<
      string,
      { execute: (...args: unknown[]) => Promise<unknown> }
    >();
    const pi = {
      registerTool: (tool: {
        name: string;
        execute: (...args: unknown[]) => Promise<unknown>;
      }) => tools.set(tool.name, tool),
      on: () => undefined,
    } as never;
    installRequestClosureBoundary(pi, lifecycle);
    const tool = tools.get('response_wait');
    if (!tool) throw new Error('response_wait was not registered');
    const receipts = [
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'background_start',
          details: {
            action: 'start',
            process: { id: 'process-1', watches: [{ id: 'watch-1' }] },
          },
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'delegate_start',
          details: {
            workflow: {
              identity: 'review@2',
              logicalId: 'review',
              jobId: 'delegate-uuid',
            },
          },
        },
      },
    ];
    const toolContext = { sessionManager: { getBranch: () => receipts } };
    const invoke = (targets: unknown[]) =>
      tool.execute('call', { targets }, undefined, undefined, toolContext);
    await expect(
      invoke([
        { kind: 'process', id: 'process-1' },
        { kind: 'watch', id: 'process-1', watchId: 'watch-1' },
        { kind: 'delegate', id: 'review' },
      ]),
    ).resolves.toMatchObject({
      details: {
        targets: [
          { kind: 'process', id: 'process-1' },
          { kind: 'watch', id: 'process-1', watchId: 'watch-1' },
          { kind: 'delegate', id: 'review@2' },
        ],
      },
    });
    await expect(
      invoke([
        { kind: 'process', id: 'process-1' },
        { kind: 'process', id: 'not-started' },
      ]),
    ).rejects.toThrow('Unknown background process');
    lifecycle.entered([
      {
        role: 'custom',
        customType: 'background-terminal-result',
        details: {
          id: 'process-1',
          dedupeKey: 'process-1',
          status: 'done',
          endedWatches: [{ id: 'watch-1', contains: 'READY' }],
        },
      },
      {
        role: 'custom',
        customType: 'delegate-job-result',
        details: {
          dedupeKey: 'delegate-uuid',
          jobs: [
            {
              id: 'delegate-uuid',
              attemptIdentity: 'review@2',
              logicalId: 'review',
              state: 'success',
            },
          ],
        },
      },
    ]);
    lifecycle.beforeSettle(event, ctx);
    expect(lifecycle.persistedMarker(ctx, appendEntry)).toMatchObject({
      data: { requestMessageId: 'user-entry' },
    });
  });

  it('accepts authoritative nested tool receipts before their parent tool result persists', async () => {
    const { lifecycle } = setup();
    const tools = new Map<
      string,
      { execute: (...args: unknown[]) => Promise<unknown> }
    >();
    const handlers = new Map<string, (...args: unknown[]) => void>();
    installRequestClosureBoundary(
      {
        registerTool: (tool: {
          name: string;
          execute: (...args: unknown[]) => Promise<unknown>;
        }) => tools.set(tool.name, tool),
        on: (name: string, handler: (...args: unknown[]) => void) =>
          handlers.set(name, handler),
      } as never,
      lifecycle,
    );
    const receipt = (toolCallId: string, toolName: string, details: unknown) =>
      handlers.get('tool_execution_end')?.(
        { toolCallId, toolName, result: { details } },
        { sessionManager: { getSessionId: () => 'session' } },
      );
    receipt('nested-bg', 'background_start', {
      process: { id: 'nested-process', watches: [{ id: 'ready' }] },
    });
    receipt('nested-delegate', 'delegate_start', {
      workflow: { identity: 'review@4', logicalId: 'review', jobId: 'job-4' },
    });
    const wait = tools.get('response_wait');
    if (!wait) throw new Error('response_wait was not registered');
    await expect(
      wait.execute(
        'wait',
        {
          targets: [
            { kind: 'process', id: 'nested-process' },
            { kind: 'watch', id: 'nested-process', watchId: 'ready' },
            { kind: 'delegate', id: 'review' },
          ],
        },
        undefined,
        undefined,
        { sessionManager: { getBranch: () => [] } },
      ),
    ).resolves.toMatchObject({
      details: {
        targets: [
          { kind: 'process', id: 'nested-process' },
          { kind: 'watch', id: 'nested-process', watchId: 'ready' },
          { kind: 'delegate', id: 'review@4' },
        ],
      },
    });
    await expect(
      wait.execute(
        'unknown',
        {
          targets: [
            { kind: 'process', id: 'nested-process' },
            { kind: 'process', id: 'unknown' },
          ],
        },
        undefined,
        undefined,
        { sessionManager: { getBranch: () => [] } },
      ),
    ).rejects.toThrow('Unknown background process');
  });

  it('does not wait again for an exact target whose result already entered history', async () => {
    const already = setup();
    const tools = new Map<
      string,
      { execute: (...args: unknown[]) => Promise<unknown> }
    >();
    installRequestClosureBoundary(
      {
        registerTool: (tool: {
          name: string;
          execute: (...args: unknown[]) => Promise<unknown>;
        }) => tools.set(tool.name, tool),
        on: () => undefined,
      } as never,
      already.lifecycle,
    );
    const tool = tools.get('response_wait');
    if (!tool) throw new Error('response_wait was not registered');
    const branch = [
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'delegate_start',
          details: {
            workflow: {
              identity: 'review@1',
              logicalId: 'review',
              jobId: 'host-job-9',
            },
          },
        },
      },
      {
        type: 'message',
        message: {
          role: 'custom',
          customType: 'delegate-job-result',
          details: {
            dedupeKey: 'host-job-9',
            jobs: [
              {
                id: 'host-job-9',
                attemptIdentity: 'review@1',
                logicalId: 'review',
                state: 'success',
              },
            ],
          },
        },
      },
    ];
    await tool.execute(
      'call',
      { targets: [{ kind: 'delegate', id: 'review' }] },
      undefined,
      undefined,
      { sessionManager: { getBranch: () => branch } },
    );
    already.lifecycle.beforeSettle(already.event, already.ctx);
    expect(
      already.lifecycle.persistedMarker(already.ctx, already.appendEntry),
    ).toMatchObject({ data: { requestMessageId: 'user-entry' } });
  });

  it('resolves coalesced ended watches and explicit stop/cancel results only after entry', () => {
    const { lifecycle, ctx, event, appendEntry } = setup();
    lifecycle.wait(
      [
        { kind: 'watch', id: 'process-1', watchId: 'watch-1' },
        { kind: 'process', id: 'process-1' },
        { kind: 'delegate', id: 'review@1' },
      ],
      new Map([['review@1', 'review@1']]),
      [],
    );
    expect(lifecycle.beforeSettle(event, ctx)).toBeUndefined();
    lifecycle.entered([
      {
        role: 'custom',
        customType: 'background-terminal-result',
        details: {
          id: 'process-1',
          dedupeKey: 'process-1',
          status: 'killed',
          endedWatches: [{ id: 'watch-1', contains: 'READY' }],
        },
      },
      {
        role: 'toolResult',
        toolName: 'delegate_jobs',
        details: {
          action: 'cancel',
          attempts: [{ identity: 'review@1', state: 'cancelled' }],
          jobs: [],
        },
      },
    ]);
    lifecycle.beforeSettle(event, ctx);
    expect(lifecycle.persistedMarker(ctx, appendEntry)).toMatchObject({
      data: { requestMessageId: 'user-entry' },
    });
  });

  it('keeps stop and cancel waits open for nonterminal snapshots', () => {
    const { lifecycle, ctx, event, appendEntry } = setup();
    lifecycle.wait(
      [
        { kind: 'process', id: 'process-1' },
        { kind: 'delegate', id: 'review@1' },
      ],
      new Map([['review@1', 'review@1']]),
      [],
    );
    lifecycle.entered([
      {
        role: 'toolResult',
        toolName: 'background_stop',
        details: {
          action: 'stop',
          processes: [{ id: 'process-1', status: 'running' }],
        },
      },
      {
        role: 'toolResult',
        toolName: 'delegate_jobs',
        details: {
          action: 'cancel',
          attempts: [{ identity: 'review@1', state: 'running' }],
          jobs: [
            { id: 'job-1', attemptIdentity: 'review@1', state: 'running' },
          ],
        },
      },
    ]);
    expect(lifecycle.beforeSettle(event, ctx)).toBeUndefined();
    expect(lifecycle.persistedMarker(ctx, appendEntry)).toBeUndefined();
    lifecycle.entered([
      {
        role: 'toolResult',
        toolName: 'background_stop',
        details: {
          action: 'stop',
          processes: [{ id: 'process-1', status: 'killed' }],
        },
      },
      {
        role: 'toolResult',
        toolName: 'delegate_jobs',
        details: {
          action: 'cancel',
          attempts: [{ identity: 'review@1', state: 'cancelled' }],
          jobs: [],
        },
      },
    ]);
    lifecycle.beforeSettle(event, ctx);
    expect(lifecycle.persistedMarker(ctx, appendEntry)).toMatchObject({
      data: { requestMessageId: 'user-entry' },
    });
  });

  it('resolves delivered delegate failures and restores the active request for steer and followUp', () => {
    const { lifecycle, ctx, event, user, appendEntry } = setup();
    lifecycle.wait(
      [{ kind: 'delegate', id: 'delegate-1' }],
      new Map([['delegate-1', 'delegate-1']]),
      [],
    );
    const boundary = event as { context: { pendingMessages: unknown[] } };
    boundary.context.pendingMessages.push({
      role: 'custom',
      customType: 'delegate-job-result',
    });
    expect(lifecycle.beforeSettle(event, ctx)).toBeUndefined();
    boundary.context.pendingMessages.length = 0;
    lifecycle.entered([
      {
        role: 'custom',
        customType: 'delegate-job-result',
        details: {
          dedupeKey: 'job-u1',
          jobs: [
            {
              id: 'job-u1',
              attemptIdentity: 'delegate-1',
              logicalId: 'review',
              state: 'error',
            },
          ],
        },
      },
    ]);
    lifecycle.beforeSettle(event, ctx);
    expect(lifecycle.persistedMarker(ctx, appendEntry)).toMatchObject({
      data: { requestMessageId: 'user-entry' },
    });

    const steering = setup();
    const steer = { role: 'user', timestamp: 15, content: 'redirect' };
    steering.lifecycle.observe('session', steer);
    steering.lifecycle.observeLiveAlias(steer, 'live-steer');
    steering.lifecycle.markSteer(steer);
    steering.lifecycle.beforeSettle(steering.event, steering.ctx);
    expect(
      steering.lifecycle.persistedMarker(steering.ctx, steering.appendEntry),
    ).toMatchObject({ data: { requestMessageId: 'user-entry' } });
    const followUp = setup();
    const nextUser = {
      role: 'user',
      timestamp: 30,
      content: 'next request',
      data: { deliveryMode: 'followUp' },
    };
    const nextAnswer = {
      role: 'assistant',
      timestamp: 40,
      content: 'next answer',
    };
    followUp.branch.push(
      {
        type: 'message',
        id: 'followup-user',
        timestamp: new Date(30).toISOString(),
        message: nextUser,
      },
      {
        type: 'message',
        id: 'followup-answer',
        timestamp: new Date(40).toISOString(),
        message: nextAnswer,
      },
    );
    followUp.lifecycle.observe('session', nextUser);
    followUp.lifecycle.observeLiveAlias(nextUser, 'live-followup-user');
    followUp.lifecycle.observe('session', nextAnswer);
    followUp.lifecycle.observeLiveAlias(nextAnswer, 'live-followup-answer');
    followUp.lifecycle.beforeSettle(followUp.event, followUp.ctx);
    expect(
      followUp.lifecycle.persistedMarker(followUp.ctx, followUp.appendEntry),
    ).toMatchObject({ data: { requestMessageId: 'followup-user' } });
    expect(user.role).toBe('user');
  });
});
