import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { getLiveExtensionSurfaceHub } from '../shared/runtime/live-surfaces';
import tasks from './index';

type Handler = (...args: unknown[]) => unknown;

type TodoTool = {
  description?: string;
  promptGuidelines?: string[];
  execute: (
    id: string,
    params: { action: string; text?: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<unknown>;
};

describe('tasks extension lifecycle', () => {
  it('ignores a late shutdown from a replaced session scope', async () => {
    const handlers = new Map<string, Handler[]>();
    let tool: TodoTool | undefined;
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerTool(definition: TodoTool) {
        tool = definition;
      },
      registerCommand: () => undefined,
      appendEntry: () => undefined,
    } as unknown as ExtensionAPI;
    const hub = getLiveExtensionSurfaceHub('tasks-scope-B');
    hub.clearAll();
    tasks(pi);
    const emit = async (event: string, ...args: unknown[]) => {
      for (const handler of handlers.get(event) ?? []) await handler(...args);
    };

    const context = (scope: string) => ({
      cwd: process.cwd(),
      hasUI: false,
      mode: 'print' as const,
      sessionManager: {
        getSessionId: () => scope,
        getBranch: () => [],
      },
    });
    const start = (scope: string) => emit('session_start', {}, context(scope));
    const shutdown = (scope: string) =>
      emit('session_shutdown', {}, context(scope));
    await start('tasks-scope-A');
    expect(tool?.description).toBe(
      'Session-scoped todo state with tasks, dependencies, statuses, priorities, and notes. Mutations update the persisted session state; dependencies reference prerequisite task ids, and notes hold extra context or block reasons.',
    );
    expect(tool?.promptGuidelines).toEqual([
      'Use todo when work has multiple meaningful steps whose progress or ordering is useful; skip it for trivial one-shot requests and simple questions.',
      'Keep the todo list synchronized with meaningful progress and plan changes rather than narrating or restating the plan in free-form text.',
      'Prefer the todo state already supplied in context; use list when the exact current state is needed or when the user asks to see it.',
    ]);
    await start('tasks-scope-B');
    try {
      await tool?.execute(
        'call-1',
        { action: 'add', text: 'Keep the replacement task' },
        undefined,
        undefined,
        context('tasks-scope-B'),
      );
      await shutdown('tasks-scope-A');

      expect(hub.snapshot()[0]?.viewModel).toMatchObject({
        tasks: [{ text: 'Keep the replacement task' }],
      });
    } finally {
      await shutdown('tasks-scope-B');
      hub.clearAll();
    }
  });
});
