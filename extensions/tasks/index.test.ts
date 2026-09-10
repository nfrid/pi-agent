import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { getLiveExtensionSurfaceHub } from '../shared/runtime/live-surfaces';
import tasks from './index';

type Handler = (...args: unknown[]) => unknown;

type TodoTool = {
  description?: string;
  promptGuidelines?: string[];
  execute: (...args: unknown[]) => Promise<unknown>;
};

describe('tasks extension lifecycle', () => {
  it('ignores a late shutdown from a replaced session scope', async () => {
    const handlers = new Map<string, Handler[]>();
    const tools = new Map<string, TodoTool>();
    let firstTool: TodoTool | undefined;
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerTool(definition: TodoTool) {
        tools.set((definition as TodoTool & { name: string }).name, definition);
        firstTool ??= definition;
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
    expect(firstTool?.description).toBe(
      'Read-only session todo list. Optionally include done and dropped tasks with include_done.',
    );
    expect(tools.get('todo_update')?.description).toBe(
      'Atomically upsert session todo tasks by stable caller id. New tasks require text and default to todo; existing tasks update only supplied fields. Forward dependency references within changes are allowed, while dependency errors and cycles reject the whole request.',
    );
    expect(tools.get('todo_remove')?.description).toBe(
      'Remove session todo tasks by stable caller id. Rejects removal when a retained task depends on any requested id.',
    );
    expect(tools.get('todo_list')?.promptGuidelines).toBeUndefined();
    expect(tools.get('todo_remove')?.promptGuidelines).toBeUndefined();
    expect(tools.get('todo_update')?.promptGuidelines).toEqual([
      'Use todo_update when work has multiple meaningful steps whose progress or ordering is useful; skip it for trivial one-shot requests and simple questions.',
      'Keep todo_update synchronized with meaningful progress and plan changes rather than narrating or restating the plan in free-form text.',
      'Use stable caller-supplied task ids in every todo_update change. New tasks require text and default to todo; existing tasks update only the fields supplied.',
      'Use todo_list when the exact current state is needed or when the user asks to see it; include_done is optional.',
      'Use todo_remove to remove tasks by id. Do not remove a task retained tasks depend on; update dependents first.',
      'todo_update validates the complete changes request atomically, so forward references between changes are allowed while dependency errors and cycles are rejected without partial updates.',
    ]);
    await start('tasks-scope-B');
    try {
      await tools
        .get('todo_update')
        ?.execute(
          'call-1',
          { changes: [{ id: 'T1', text: 'Keep the replacement task' }] },
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
