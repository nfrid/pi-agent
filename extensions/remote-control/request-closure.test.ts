import { describe, expect, it } from 'vitest';
import { markLogicalSteering } from '../shared/runtime/logical-input';
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
  let nextEntry = 0;
  let currentBranch: Array<Record<string, unknown>> = branch;
  const ctx = {
    sessionManager: {
      getSessionId: () => 'session',
      getBranch: () => currentBranch,
    },
  } as never;
  const event = {
    outcome: 'completed',
    continue: false,
    context: { pendingMessages: [] },
  } as never;
  const appendEntry = (customType: string, data: unknown) => {
    nextEntry += 1;
    branch.push({
      type: 'custom',
      id: `custom-${nextEntry}`,
      parentId: 'assistant-entry',
      timestamp: new Date(20 + nextEntry).toISOString(),
      customType,
      data,
    });
  };
  lifecycle.observe('session', user, branch);
  lifecycle.observeLiveAlias(user, 'live-user');
  lifecycle.observe('session', answer, branch);
  lifecycle.observeLiveAlias(answer, 'live-answer');
  const settle = () => {
    lifecycle.beforeSettle(event, ctx, appendEntry);
    return lifecycle.persistedMarker(ctx, appendEntry);
  };
  const register = (kind: 'process' | 'watch' | 'delegate', id: string) =>
    lifecycle.registerDependency(kind, id, ctx, appendEntry);
  const entered = (messages: readonly unknown[]) =>
    lifecycle.entered(messages, ctx, appendEntry);
  return {
    lifecycle,
    user,
    answer,
    branch,
    setBranch: (value: Array<Record<string, unknown>>) => {
      currentBranch = value;
    },
    ctx,
    event,
    appendEntry,
    register,
    entered,
    settle,
  };
}

const processResult = (
  id: string,
  status = 'done',
  endedWatches?: unknown[],
) => ({
  role: 'custom',
  customType: 'background-terminal-result',
  details: { id, status, ...(endedWatches ? { endedWatches } : {}) },
});
const watchResult = (id: string, watchId: string, status = 'matched') => ({
  role: 'custom',
  customType: 'background-watch-result',
  details: { id, watchId, status },
});

describe('automatic request closure dependencies', () => {
  it('registers a task at source creation and closes only after its result enters context', () => {
    const f = setup();
    f.register('process', 'task-1');
    expect(f.settle()).toBeUndefined();
    const pending = f.event as { context: { pendingMessages: unknown[] } };
    pending.context.pendingMessages.push(processResult('task-1'));
    expect(f.settle()).toBeUndefined();
    pending.context.pendingMessages.length = 0;
    f.entered([processResult('task-1', 'failed')]);
    expect(f.settle()).toMatchObject({
      customType: 'response-closure',
      data: {
        requestMessageId: 'user-entry',
        finalMessageId: 'assistant-entry',
        liveRequestMessageId: 'live-user',
        liveFinalMessageId: 'live-answer',
      },
    });
  });

  it('lets a passive service close without a watch and waits for a service watch', () => {
    const passive = setup();
    expect(passive.settle()).toMatchObject({
      data: { requestMessageId: 'user-entry' },
    });

    const watched = setup();
    watched.register('watch', 'server:ready');
    expect(watched.settle()).toBeUndefined();
    watched.entered([watchResult('server', 'ready', 'timed_out')]);
    expect(watched.settle()).toMatchObject({
      data: { requestMessageId: 'user-entry' },
    });
  });

  it('keeps task exit required after an early watch and treats failed exits as outcomes', () => {
    const f = setup();
    f.register('process', 'task-2');
    f.register('watch', 'task-2:progress');
    f.entered([watchResult('task-2', 'progress')]);
    expect(f.settle()).toBeUndefined();
    f.entered([
      processResult('task-2', 'failed', [{ id: 'late', contains: 'done' }]),
    ]);
    expect(f.settle()).toMatchObject({
      data: { requestMessageId: 'user-entry' },
    });
  });

  it('keeps unrelated delegates required while all and any gates affect selected refs only', () => {
    const all = setup();
    all.register('delegate', 'a@1');
    all.register('delegate', 'b@1');
    all.register('delegate', 'other@1');
    all.lifecycle.resolveDelegateGate(['a@1', 'b@1'], 'all', all.appendEntry);
    expect(all.settle()).toBeUndefined();
    all.entered([
      {
        role: 'custom',
        customType: 'delegate-wake-result',
        details: { sources: ['a@1', 'b@1'] },
      },
    ]);
    expect(all.settle()).toBeUndefined();
    all.entered([
      {
        role: 'custom',
        customType: 'delegate-job-result',
        details: { jobs: [{ attemptIdentity: 'other@1', state: 'error' }] },
      },
    ]);
    all.lifecycle.resolveDelegateGate(['other@1'], 'all', all.appendEntry);
    expect(all.settle()).toMatchObject({
      data: { requestMessageId: 'user-entry' },
    });

    const any = setup();
    any.register('delegate', 'first@1');
    any.register('delegate', 'second@1');
    any.register('delegate', 'unrelated@1');
    any.lifecycle.resolveDelegateGate(
      ['first@1', 'second@1'],
      'any',
      any.appendEntry,
    );
    // A wake removed by a later context filter never reaches this entry hook.
    expect(any.settle()).toBeUndefined();
    any.entered([
      {
        role: 'custom',
        customType: 'delegate-wake-result',
        details: { sources: ['first@1'] },
      },
    ]);
    expect(any.settle()).toBeUndefined();
    any.entered([
      {
        role: 'custom',
        customType: 'delegate-job-result',
        details: {
          jobs: [{ attemptIdentity: 'unrelated@1', state: 'success' }],
        },
      },
    ]);
    any.lifecycle.resolveDelegateGate(['unrelated@1'], 'all', any.appendEntry);
    expect(any.settle()).toMatchObject({
      data: { requestMessageId: 'user-entry' },
    });
  });

  it('requires nested stop and cancel outcomes to enter with their codemode result', () => {
    const f = setup();
    f.register('process', 'process-1');
    f.register('delegate', 'review@1');
    f.lifecycle.observeToolReceipt(
      'session',
      'nested-stop',
      'background_stop',
      {
        details: {
          action: 'stop',
          processes: [{ id: 'process-1', status: 'killed' }],
        },
      },
      'script-call',
    );
    f.lifecycle.observeToolReceipt(
      'session',
      'nested-cancel',
      'delegate_jobs',
      {
        details: {
          action: 'cancel',
          attempts: [{ identity: 'review@1', state: 'cancelled' }],
        },
      },
      'script-call',
    );
    expect(f.settle()).toBeUndefined();
    f.entered([
      {
        role: 'toolResult',
        toolName: 'codemode',
        toolCallId: 'script-call',
        nestedCalls: {
          calls: [{ id: 'nested-stop' }, { id: 'nested-cancel' }],
        },
      },
    ]);
    expect(f.settle()).toMatchObject({
      data: { requestMessageId: 'user-entry' },
    });
  });

  it('does not clear a process dependency for stop intent or a nonterminal result', () => {
    const f = setup();
    f.register('process', 'process-2');
    f.entered([
      {
        role: 'toolResult',
        toolName: 'background_stop',
        details: {
          action: 'stop',
          processes: [{ id: 'process-2', status: 'running' }],
        },
      },
    ]);
    expect(f.settle()).toBeUndefined();
    f.entered([
      {
        role: 'toolResult',
        toolName: 'background_stop',
        details: {
          action: 'stop',
          processes: [{ id: 'process-2', status: 'killed' }],
        },
      },
    ]);
    expect(f.settle()).toMatchObject({
      data: { requestMessageId: 'user-entry' },
    });
  });

  it('keeps steering in the request and treats follow-up as a later request', () => {
    const f = setup();
    f.register('process', 'task-3');
    const steer = {
      role: 'user',
      content: 'redirect',
    };
    markLogicalSteering(steer);
    f.lifecycle.observe('session', steer, f.branch);
    expect(f.lifecycle.hasPendingWait(f.ctx)).toBe(true);
    f.entered([processResult('task-3')]);
    expect(f.settle()).toMatchObject({
      data: { requestMessageId: 'user-entry' },
    });

    const next = {
      role: 'user',
      content: 'next request',
    };
    f.lifecycle.observe('session', next, f.branch);
    const nextAnswer = { role: 'assistant', content: 'next answer' };
    f.lifecycle.observe('session', nextAnswer, f.branch);
    f.branch.push(
      {
        type: 'message',
        id: 'followup-user',
        timestamp: new Date(30).toISOString(),
        message: next,
      },
      {
        type: 'message',
        id: 'followup-answer',
        timestamp: new Date(40).toISOString(),
        message: nextAnswer,
      },
    );
    expect(f.settle()).toMatchObject({
      data: { requestMessageId: 'followup-user' },
    });
  });

  it('uses exact steering IDs, not colliding text or timestamps, for restored ownership', () => {
    const f = setup();
    f.register('process', 'original-task');
    const steer = { role: 'user', content: 'same text', timestamp: 10 };
    f.branch.push({ type: 'message', id: 'steering-user', message: steer });
    f.branch.push({
      type: 'custom',
      customType: 'steering-message',
      data: {
        userEntryId: 'steering-user',
        text: 'same text',
        timestamp: 10,
      },
    });
    const restored = new RequestClosureLifecycle();
    restored.restore(f.ctx);
    expect(restored.isRequired('process', 'original-task', f.ctx)).toBe(true);
    expect(
      restored.registerDependency(
        'process',
        'new-source',
        f.ctx,
        f.appendEntry,
      ),
    ).toBe(true);
    f.branch.push({
      type: 'message',
      id: 'ordinary-user',
      message: { ...steer },
    });
    expect(
      restored.registerDependency(
        'process',
        'wrong-owner',
        f.ctx,
        f.appendEntry,
      ),
    ).toBe(false);
    restored.restore(f.ctx);
    expect(restored.hasPendingWait(f.ctx)).toBe(false);
  });

  it('does not infer ownership from an ambiguous legacy steering marker', () => {
    const f = setup();
    f.register('process', 'original-task');
    f.branch.push({
      type: 'custom',
      customType: 'steering-message',
      data: { timestamp: 10, text: 'redirect' },
    });
    f.branch.push({
      type: 'message',
      id: 'legacy-user',
      message: { role: 'user', content: 'redirect', timestamp: 10 },
    });
    const restored = new RequestClosureLifecycle();
    restored.restore(f.ctx);
    expect(restored.hasPendingWait(f.ctx)).toBe(false);
    expect(f.register('process', 'ambiguous-source')).toBe(false);
  });

  it('rejects nonterminal or incomplete background result shapes', () => {
    const f = setup();
    f.register('process', 'task-invalid');
    f.register('watch', 'task-invalid:watch-invalid');
    f.entered([processResult('task-invalid', 'running')]);
    expect(f.settle()).toBeUndefined();
    f.entered([
      processResult('task-invalid', 'done', [
        { id: 'watch-invalid', status: 'pending' },
      ]),
    ]);
    expect(f.settle()).toBeUndefined();
    f.entered([watchResult('task-invalid', 'watch-invalid')]);
    expect(f.settle()).toMatchObject({
      data: { requestMessageId: 'user-entry' },
    });
  });

  it('abandons dependencies durably after an abort and does not restore the request', () => {
    const f = setup();
    f.register('process', 'aborted-task');
    (f.event as { outcome: string }).outcome = 'aborted';
    f.lifecycle.beforeSettle(f.event, f.ctx, f.appendEntry);
    expect(f.lifecycle.hasPendingWait(f.ctx)).toBe(false);
    expect(f.branch).toContainEqual(
      expect.objectContaining({
        customType: 'request-dependency:v1',
        data: expect.objectContaining({
          operation: 'abandon-request',
          requestMessageId: 'user-entry',
        }),
      }),
    );
    f.lifecycle.restore(f.ctx);
    expect(f.lifecycle.hasPendingWait(f.ctx)).toBe(false);
  });

  it('persists an abort even when no source dependency remains', () => {
    const f = setup();
    (f.event as { outcome: string }).outcome = 'aborted';
    f.lifecycle.beforeSettle(f.event, f.ctx, f.appendEntry);
    const restored = new RequestClosureLifecycle();
    restored.restore(f.ctx);
    expect(restored.hasPendingWait(f.ctx)).toBe(false);
    expect(restored.persistedMarker(f.ctx, f.appendEntry)).toBeUndefined();
  });

  it('restores a service watch without treating service exit as a dependency', () => {
    const f = setup();
    f.register('watch', 'service-1:ready');
    const restored = new RequestClosureLifecycle();
    restored.restore(f.ctx);
    expect(restored.hasPendingWait(f.ctx)).toBe(true);
    restored.entered([processResult('service-1')], f.ctx, f.appendEntry);
    expect(restored.hasPendingWait(f.ctx)).toBe(true);
    restored.entered([watchResult('service-1', 'ready')], f.ctx, f.appendEntry);
    expect(restored.hasPendingWait(f.ctx)).toBe(false);
  });

  it('does not register a source against an older request on the selected branch', () => {
    const f = setup();
    f.register('process', 'original-task');
    const laterUser = { role: 'user', content: 'later request' };
    f.branch.push({
      type: 'message',
      id: 'later-user-entry',
      timestamp: new Date(30).toISOString(),
      message: laterUser,
    });
    expect(f.register('process', 'unowned-task')).toBe(false);
    expect(
      f.branch.filter(
        (entry) =>
          entry.customType === 'request-dependency:v1' &&
          entry.data !== null &&
          typeof entry.data === 'object' &&
          'id' in entry.data &&
          entry.data.id === 'unowned-task',
      ),
    ).toHaveLength(0);
  });

  it('clears old dependencies when restoring a different selected branch', () => {
    const f = setup();
    f.register('process', 'old-branch-task');
    const nextUser = { role: 'user', content: 'other branch' };
    f.setBranch([
      {
        type: 'message',
        id: 'other-user-entry',
        timestamp: new Date(30).toISOString(),
        message: nextUser,
      },
    ]);
    f.lifecycle.restore(f.ctx);
    expect(f.lifecycle.hasPendingWait(f.ctx)).toBe(false);
  });

  it('restores only source metadata owned by the exact session and request', () => {
    const f = setup();
    f.register('process', 'restore-task');
    const restored = new RequestClosureLifecycle();
    restored.restore(f.ctx);
    expect(restored.hasPendingWait(f.ctx)).toBe(true);
    restored.entered([processResult('restore-task')], f.ctx, f.appendEntry);
    restored.beforeSettle(f.event, f.ctx, f.appendEntry);
    expect(restored.persistedMarker(f.ctx, f.appendEntry)).toMatchObject({
      data: { requestMessageId: 'user-entry' },
    });

    const isolated = new RequestClosureLifecycle();
    const otherCtx = {
      sessionManager: {
        getSessionId: () => 'other-session',
        getBranch: () => f.branch,
      },
    } as never;
    isolated.restore(otherCtx);
    expect(isolated.hasPendingWait(otherCtx)).toBe(false);
  });

  it('acknowledges results after context filters and persists markers only at genuine settlement', () => {
    const f = setup();
    const tools = new Map<string, unknown>();
    const handlers = new Map<string, (...args: never[]) => unknown>();
    installRequestClosureBoundary(
      {
        registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
        on: (name: string, handler: (...args: never[]) => unknown) =>
          handlers.set(name, handler),
        appendEntry: f.appendEntry,
      } as never,
      f.lifecycle,
    );
    expect(tools.size).toBe(0);
    const continuing = f.event as { continue: boolean };
    continuing.continue = true;
    f.lifecycle.beforeSettle(f.event, f.ctx, f.appendEntry);
    expect(f.lifecycle.persistedMarker(f.ctx, f.appendEntry)).toBeUndefined();
    continuing.continue = false;
    expect(handlers.has('context')).toBe(false);
    const entered = handlers.get('context_with_system');
    expect(entered).toBeDefined();
    f.register('process', 'filtered-task');
    entered?.({ messages: [] } as never, f.ctx);
    expect(f.settle()).toBeUndefined();
    entered?.({ messages: [processResult('filtered-task')] } as never, f.ctx);
    expect(f.settle()).toMatchObject({
      customType: 'response-closure',
      data: { requestMessageId: 'user-entry' },
    });
  });
});
