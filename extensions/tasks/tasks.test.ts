import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EXACT_TODO_RESULT_PREFIX,
  registerTodoContext,
  TODO_RESULT_ELIDED,
  TODO_SNAPSHOT_TYPE,
  type TodoContextMessages,
  transformTodoContext,
} from './context';
import { turnSnapshotText } from './format';
import {
  MAX_TODO_RESULT_CHARS,
  todoListParamsSchema,
  todoRemoveParamsSchema,
  todoUpdateParamsSchema,
} from './model';
import { applyMutation, mutate } from './mutations';
import {
  applySnapshot,
  cloneState,
  createTaskStore,
  initialState,
} from './store';
import { registerTodoTool } from './tool';
import { updateUi } from './widget';

let store = createTaskStore();

function user(text: string, timestamp = 1): TodoContextMessages[number] {
  return {
    role: 'user',
    content: text,
    timestamp,
  } as TodoContextMessages[number];
}

function legacyReplay(
  content: string,
  timestamp: number,
): TodoContextMessages[number] {
  return {
    role: 'custom',
    customType: 'lean-todo-replay',
    content,
    display: false,
    timestamp,
  };
}

function isSnapshot(message: TodoContextMessages[number]): boolean {
  return message.role === 'custom' && message.customType === TODO_SNAPSHOT_TYPE;
}

function snapshot(
  content: string,
  timestamp: number,
): TodoContextMessages[number] {
  return {
    role: 'custom',
    customType: TODO_SNAPSHOT_TYPE,
    content,
    display: false,
    timestamp,
  };
}

function result(
  id: number,
  toolName = 'todo_update',
): TodoContextMessages[number] {
  return {
    role: 'toolResult',
    toolCallId: `call-${id}`,
    toolName,
    content: [{ type: 'text', text: `exact-${id}` }],
    isError: false,
    timestamp: id,
  } as TodoContextMessages[number];
}

function text(
  message: TodoContextMessages[number] | undefined,
): string | undefined {
  if (!message || !('content' in message) || !Array.isArray(message.content))
    return undefined;
  const part = message.content[0];
  return part?.type === 'text' ? part.text : undefined;
}

describe('immutable todo turn snapshots', () => {
  it('preserves multi-turn snapshots and exact results after the newest snapshot', () => {
    const first = snapshot('turn-one-state', 10);
    const second = snapshot('turn-two-state', 30);
    const input = [
      user('first turn', 2),
      first,
      ...Array.from({ length: 10 }, (_, index) => result(index + 1)),
      user('second turn', 20),
      second,
      ...Array.from({ length: 8 }, (_, index) => result(index + 11)),
    ];
    const before = structuredClone(input);

    const transformed = transformTodoContext(input, 'current-state', 99);

    expect(input).toEqual(before);
    expect(
      transformed.filter(
        (message) =>
          message.role === 'custom' &&
          message.customType === TODO_SNAPSHOT_TYPE,
      ),
    ).toEqual([first, second]);
    const results = transformed.filter(
      (message) => message.role === 'toolResult',
    );
    for (let index = 0; index < EXACT_TODO_RESULT_PREFIX; index++)
      expect(text(results[index])).toBe(`exact-${index + 1}`);
    for (let index = EXACT_TODO_RESULT_PREFIX; index < 10; index++)
      expect(text(results[index])).toBe(TODO_RESULT_ELIDED);
    expect(results.slice(10).map(text)).toEqual(
      Array.from({ length: 8 }, (_, index) => `exact-${index + 11}`),
    );
  });

  it('never refreshes an existing snapshot from later state', () => {
    const input = [user('turn'), snapshot('immutable-state', 2), result(1)];

    expect(transformTodoContext(input, 'current-a', 10)).toEqual(
      transformTodoContext(input, 'current-b', 20),
    );
    expect(transformTodoContext(input, 'current-a', 10)[1]).toEqual(
      snapshot('immutable-state', 2),
    );
  });

  it('keeps a fixed first-six prefix with arbitrarily many old results', () => {
    const transformed = transformTodoContext(
      [
        snapshot('old', 1),
        ...Array.from({ length: 1_000 }, (_, index) => result(index + 1)),
        snapshot('newest', 2),
      ],
      'unused',
      3,
    );
    const results = transformed.filter(
      (message) => message.role === 'toolResult',
    );

    for (let index = 0; index < EXACT_TODO_RESULT_PREFIX; index++)
      expect(text(results[index])).toBe(`exact-${index + 1}`);
    expect(text(results[EXACT_TODO_RESULT_PREFIX])).toBe(TODO_RESULT_ELIDED);
    expect(text(results[999])).toBe(TODO_RESULT_ELIDED);
  });

  it('retains exact evidence and appends a snapshot when the anchor is missing', () => {
    const input = Array.from({ length: 12 }, (_, index) => result(index + 1));
    const transformed = transformTodoContext(input, 'recovered-state', 50);

    expect(transformed.slice(0, 12).map(text)).toEqual(
      Array.from({ length: 12 }, (_, index) => `exact-${index + 1}`),
    );
    expect(transformed.at(-1)).toEqual(snapshot('recovered-state', 50));
  });

  it('appends current state after compact/tree recovery', () => {
    const old = snapshot('old-state', 2);
    const transformed = transformTodoContext(
      [user('turn'), old, result(1)],
      'current-state',
      60,
      true,
    );

    expect(transformed[1]).toEqual(old);
    expect(transformed.at(-1)).toEqual(snapshot('current-state', 60));
  });

  it('removes legacy mutable replay messages in all paths', () => {
    const anchored = transformTodoContext(
      [legacyReplay('stale', 1), snapshot('state', 2), result(1)],
      'unused',
      3,
    );
    const missing = transformTodoContext(
      [legacyReplay('stale', 1), result(1)],
      'state',
      3,
    );

    for (const messages of [anchored, missing])
      expect(
        messages.some(
          (message) =>
            message.role === 'custom' &&
            message.customType === 'lean-todo-replay',
        ),
      ).toBe(false);
  });

  it('recognizes immutable snapshots persisted by the previous wire type', () => {
    const persisted = {
      ...snapshot('persisted-state', 2),
      customType: 'lean-todo-replay-v2',
    };
    const transformed = transformTodoContext(
      [
        ...Array.from({ length: 8 }, (_, index) => result(index + 1)),
        persisted,
        result(9),
      ],
      'unused',
      3,
    );

    expect(transformed[8]).toEqual(persisted);
    expect(text(transformed[6])).toBe(TODO_RESULT_ELIDED);
    expect(text(transformed[9])).toBe('exact-9');
  });

  it('uses a production snapshot wire type and turn-start wording', () => {
    expect(TODO_SNAPSHOT_TYPE).toBe('lean-todo-turn-snapshot');
    const content = turnSnapshotText(store);
    expect(content).toContain('Todo state at the start of this user turn');
    expect(content).toContain(
      'Later todo results and newer snapshots replace this',
    );
    expect(content).not.toContain('survives compaction/forking');
  });
});

describe('registerTodoContext', () => {
  function registeredContext() {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;
    registerTodoContext(pi, store);
    return handlers;
  }

  it('does not inject a snapshot into a fresh empty session', () => {
    store = createTaskStore();
    const handlers = registeredContext();
    expect(handlers.get('before_agent_start')?.()).toBeUndefined();
    expect(
      (handlers.get('context')?.({ messages: [] }) as { messages: unknown[] })
        .messages,
    ).toEqual([]);
  });

  it('injects active state at turn start', () => {
    store = createTaskStore();
    mutate(store, 'todo_update', {
      changes: [{ id: 'T1', text: 'active task' }],
    });
    const handlers = registeredContext();
    const turnStart = handlers.get('before_agent_start')?.() as {
      message: { customType: string; content: string };
    };
    expect(turnStart.message.customType).toBe(TODO_SNAPSHOT_TYPE);
    expect(turnStart.message.content).toContain('active task');
  });

  it('persists one empty reset across subsequent empty turns', () => {
    store = createTaskStore();
    mutate(store, 'todo_update', {
      changes: [{ id: 'T1', text: 'stale task' }],
    });
    const handlers = registeredContext();
    const activeStart = handlers.get('before_agent_start')?.() as {
      message: { customType: string; content: string };
    };
    let history: TodoContextMessages = [
      snapshot(activeStart.message.content, 1),
    ];

    store.state.tasks = [];
    const resetStart = handlers.get('before_agent_start')?.() as {
      message: { customType: string; content: string };
    };
    expect(resetStart.message.customType).toBe(TODO_SNAPSHOT_TYPE);
    history = [...history, snapshot(resetStart.message.content, 2)];
    const first = handlers.get('context')?.({ messages: history }) as {
      messages: TodoContextMessages;
    };
    expect(
      first.messages.filter(
        (message) => message.role === 'custom' && isSnapshot(message),
      ),
    ).toHaveLength(1);

    history = [...history, user('first unchanged empty turn', 3)];
    expect(handlers.get('before_agent_start')?.()).toBeUndefined();
    const second = handlers.get('context')?.({ messages: history }) as {
      messages: TodoContextMessages;
    };
    history = [...history, user('second unchanged empty turn', 4)];
    expect(handlers.get('before_agent_start')?.()).toBeUndefined();
    const third = handlers.get('context')?.({ messages: history }) as {
      messages: TodoContextMessages;
    };

    for (const contextualized of [first, second, third]) {
      const snapshots = contextualized.messages.filter(
        (message) => message.role === 'custom' && isSnapshot(message),
      );
      expect(snapshots).toHaveLength(1);
      expect((snapshots[0] as { content: string }).content).not.toContain(
        'stale task',
      );
    }
  });

  it('persists a replacement reset when inactive state changes', () => {
    store = createTaskStore();
    mutate(store, 'todo_update', {
      changes: [{ id: 'T1', text: 'finish me' }],
    });
    const handlers = registeredContext();
    const activeStart = handlers.get('before_agent_start')?.() as {
      message: { content: string };
    };
    let history: TodoContextMessages = [
      snapshot(activeStart.message.content, 1),
    ];

    mutate(store, 'todo_update', { changes: [{ id: 'T1', status: 'done' }] });
    const completedReset = handlers.get('before_agent_start')?.() as {
      message: { content: string };
    };
    history = [...history, snapshot(completedReset.message.content, 2)];
    handlers.get('context')?.({ messages: history });

    mutate(store, 'todo_remove', { ids: ['T1'] });
    const emptyReset = handlers.get('before_agent_start')?.() as {
      message: { content: string };
    };
    expect(emptyReset.message.content).not.toBe(completedReset.message.content);
    history = [...history, snapshot(emptyReset.message.content, 3)];
    const replaced = handlers.get('context')?.({ messages: history }) as {
      messages: TodoContextMessages;
    };
    expect(replaced.messages.filter(isSnapshot)).toHaveLength(1);
    expect(handlers.get('before_agent_start')?.()).toBeUndefined();
    const unchanged = handlers.get('context')?.({ messages: history }) as {
      messages: TodoContextMessages;
    };
    expect(unchanged.messages.filter(isSnapshot)).toHaveLength(1);
  });

  it('recovers active state after compaction/tree recovery', () => {
    store = createTaskStore();
    mutate(store, 'todo_update', {
      changes: [{ id: 'T1', text: 'recover me' }],
    });
    const handlers = registeredContext();
    handlers.get('session_compact')?.();
    const contextualized = handlers.get('context')?.({
      messages: [snapshot('old', 1), result(1)],
    }) as { messages: TodoContextMessages };
    expect(contextualized.messages.at(-1)).toMatchObject({
      role: 'custom',
      customType: TODO_SNAPSHOT_TYPE,
    });
    expect(contextualized.messages.at(-1)).toMatchObject({
      content: expect.stringContaining('recover me'),
    });
  });
});

describe('restored task regressions', () => {
  beforeEach(() => {
    store = createTaskStore();
    applySnapshot(store, initialState());
  });

  it('isolates mutable state between extension-owned stores', () => {
    const other = createTaskStore();
    expect(
      mutate(store, 'todo_update', { changes: [{ id: 'T1', text: 'first' }] }),
    ).toMatchObject({ changed: true });
    expect(
      mutate(other, 'todo_update', { changes: [{ id: 'T1', text: 'second' }] }),
    ).toMatchObject({ changed: true });
    expect(store.state.tasks[0]?.text).toBe('first');
    expect(other.state.tasks[0]?.text).toBe('second');
  });

  it('rolls back fields changed before invalid dependency validation', () => {
    expect(
      mutate(store, 'todo_update', {
        changes: [{ id: 'T1', text: 'original' }],
      }),
    ).toMatchObject({
      changed: true,
    });
    const before = cloneState(store);
    const stateReference = store.state;

    const result = mutate(store, 'todo_update', {
      changes: [
        {
          id: 'T1',
          text: 'leaked change',
          status: 'doing',
          depends_on: ['missing'],
        },
      ],
    });

    expect(result).toMatchObject({
      changed: false,
      error: 'unknown dependencies: missing',
    });
    expect(cloneState(store)).toEqual(before);
    expect(store.state).toBe(stateReference);
  });

  it('throws failed tool executions so Pi records an error result', async () => {
    let tool:
      | {
          execute: (
            id: string,
            params: Record<string, unknown>,
            signal: AbortSignal,
            onUpdate: undefined,
            ctx: unknown,
          ) => Promise<unknown>;
        }
      | undefined;
    registerTodoTool(
      {
        registerTool(value: typeof tool) {
          if ((value as { name?: string }).name === 'todo_remove') tool = value;
        },
        appendEntry() {},
      } as unknown as ExtensionAPI,
      store,
    );

    await expect(
      tool?.execute(
        'invalid',
        { ids: ['missing'] },
        new AbortController().signal,
        undefined,
        { hasUI: false },
      ),
    ).rejects.toThrow('unknown task missing');
  });

  it('rolls back mutation state when persistence fails', async () => {
    let tool:
      | {
          execute: (
            id: string,
            params: Record<string, unknown>,
            signal: AbortSignal,
            onUpdate: undefined,
            ctx: unknown,
          ) => Promise<unknown>;
        }
      | undefined;
    registerTodoTool(
      {
        registerTool(value: typeof tool) {
          if ((value as { name?: string }).name === 'todo_update') tool = value;
        },
        appendEntry() {
          throw new Error('persistence failed');
        },
      } as unknown as ExtensionAPI,
      store,
    );
    const before = cloneState(store);

    await expect(
      tool?.execute(
        'add',
        { changes: [{ id: 'T1', text: 'must roll back' }] },
        new AbortController().signal,
        undefined,
        { hasUI: false },
      ),
    ).rejects.toThrow('persistence failed');
    expect(cloneState(store)).toEqual(before);
  });

  it('rolls back interactive mutations when persistence fails', () => {
    expect(() =>
      applyMutation(
        store,
        {
          appendEntry: () => {
            throw new Error('interactive persistence failed');
          },
        } as never,
        { hasUI: false } as never,
        'todo_update',
        { changes: [{ id: 'T1', text: 'must not leak' }] },
      ),
    ).toThrow('interactive persistence failed');
    expect(store.state).toEqual(initialState());
  });

  it('does not persist an interactive mutation when UI update fails', () => {
    const persisted: Array<{ state: ReturnType<typeof initialState> }> = [];
    let updates = 0;
    const pi = {
      appendEntry(
        _type: string,
        data: { state: ReturnType<typeof initialState> },
      ) {
        persisted.push(structuredClone(data));
      },
    } as never;
    const ctx = {
      hasUI: true,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus() {
          updates++;
          if (updates === 1) throw new Error('UI failed');
        },
        setWidget() {},
      },
    } as never;

    expect(() =>
      applyMutation(store, pi, ctx, 'todo_update', {
        changes: [{ id: 'T1', text: 'must be compensated' }],
      }),
    ).toThrow('UI failed');
    expect(store.state).toEqual(initialState());
    expect(persisted).toEqual([]);
  });

  it('does not persist a tool mutation when UI update fails', async () => {
    const persisted: Array<{ state: ReturnType<typeof initialState> }> = [];
    let tool:
      | {
          execute: (
            id: string,
            params: Record<string, unknown>,
            signal: AbortSignal,
            onUpdate: undefined,
            ctx: unknown,
          ) => Promise<unknown>;
        }
      | undefined;
    registerTodoTool(
      {
        registerTool(value: typeof tool) {
          if ((value as { name?: string }).name === 'todo_update') tool = value;
        },
        appendEntry(
          _type: string,
          data: { state: ReturnType<typeof initialState> },
        ) {
          persisted.push(structuredClone(data));
        },
      } as unknown as ExtensionAPI,
      store,
    );
    let updates = 0;
    const ctx = {
      hasUI: true,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus() {
          updates++;
          if (updates === 1) throw new Error('tool UI failed');
        },
        setWidget() {},
      },
    };

    await expect(
      tool?.execute(
        'todo_update',
        { changes: [{ id: 'T1', text: 'must be compensated' }] },
        new AbortController().signal,
        undefined,
        ctx,
      ),
    ).rejects.toThrow('tool UI failed');
    expect(store.state).toEqual(initialState());
    expect(persisted).toEqual([]);
  });
});

describe('todo widget lifecycle', () => {
  beforeEach(() => {
    store = createTaskStore();
    applySnapshot(store, initialState());
  });

  it('records every completion outside render and renders without mutation', () => {
    mutate(store, 'todo_update', {
      changes: Array.from({ length: 15 }, (_, index) => ({
        id: `T${index + 1}`,
        text: `done ${index + 1}`,
        status: 'done' as const,
      })),
    });
    let widgetFactory:
      | ((
          tui: unknown,
          theme: { fg: (_color: string, value: string) => string },
        ) => { render: (width: number) => string[] })
      | undefined;
    const theme = {
      fg: (_color: string, value: string) => value,
      strikethrough: (value: string) => value,
    };
    updateUi(store, {
      hasUI: true,
      ui: {
        theme,
        setStatus() {},
        setWidget(_id: string, widget: typeof widgetFactory) {
          widgetFactory = widget;
        },
      },
    } as never);
    expect(store.completedPendingHide.size).toBe(15);
    const pending = [...store.completedPendingHide];
    const hidden = [...store.hiddenCompleted];
    const widget = widgetFactory?.({ requestRender() {} }, theme);

    expect(widget?.render(100)).toEqual(widget?.render(100));
    expect([...store.completedPendingHide]).toEqual(pending);
    expect([...store.hiddenCompleted]).toEqual(hidden);
  });
});

describe('bounded todo tool results', () => {
  it('caps large task rows and marks omitted state', async () => {
    const localStore = createTaskStore();
    for (let index = 0; index < 100; index += 1) {
      mutate(localStore, 'todo_update', {
        changes: [
          {
            id: `T${index + 1}`,
            text: `task-${index} ${'detail '.repeat(200)}`,
            notes: 'note '.repeat(200),
          },
        ],
      });
    }

    let tool:
      | {
          execute: (
            id: string,
            params: Record<string, unknown>,
            signal: AbortSignal | undefined,
            onUpdate: undefined,
            ctx: unknown,
          ) => Promise<{ content: Array<{ text: string }> }>;
        }
      | undefined;
    registerTodoTool(
      {
        registerTool(value: typeof tool) {
          if ((value as { name?: string }).name === 'todo_list') tool = value;
        },
        appendEntry() {},
      } as never,
      localStore,
    );

    const response = await tool?.execute(
      'call-list',
      {},
      undefined,
      undefined,
      { hasUI: false } as never,
    );
    const text = response?.content[0]?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(MAX_TODO_RESULT_CHARS);
    expect(text).toContain('todo output capped');
    expect(text).toContain('more tasks omitted');
  });
});

describe('todo mutations', () => {
  beforeEach(() => {
    store = createTaskStore();
    applySnapshot(store, initialState());
  });

  it('upserts stable ids and defaults new tasks', () => {
    expect(
      mutate(store, 'todo_update', {
        changes: [{ id: 'caller-1', text: ' first ', priority: 'high' }],
      }),
    ).toMatchObject({ changed: true });
    expect(store.state.tasks[0]).toMatchObject({
      id: 'caller-1',
      text: 'first',
      status: 'todo',
      dependsOn: [],
      priority: 'high',
    });

    mutate(store, 'todo_update', {
      changes: [{ id: 'caller-1', notes: 'context', status: 'doing' }],
    });
    expect(store.state.tasks).toHaveLength(1);
    expect(store.state.tasks[0]).toMatchObject({
      text: 'first',
      status: 'doing',
      priority: 'high',
      notes: 'context',
    });
  });

  it('allows forward references and validates the complete request atomically', () => {
    expect(
      mutate(store, 'todo_update', {
        changes: [
          { id: 'T1', text: 'first', depends_on: ['T2'] },
          { id: 'T2', text: 'second' },
        ],
      }),
    ).toMatchObject({ changed: true });
    const before = cloneState(store);
    const result = mutate(store, 'todo_update', {
      changes: [
        { id: 'T1', text: 'changed', depends_on: ['T2'] },
        { id: 'T2', depends_on: ['T1'] },
      ],
    });
    expect(result.error).toContain('dependency cycle:');
    expect(cloneState(store)).toEqual(before);
  });

  it('rejects missing new text and invalid dependencies without partial updates', () => {
    mutate(store, 'todo_update', { changes: [{ id: 'T1', text: 'original' }] });
    const before = cloneState(store);
    const result = mutate(store, 'todo_update', {
      changes: [
        { id: 'T1', text: 'leaked' },
        { id: 'T2', depends_on: ['missing'] },
      ],
    });
    expect(result.error).toBe('T2 requires text when creating a task');
    expect(cloneState(store)).toEqual(before);

    const missingText = mutate(store, 'todo_update', {
      changes: [{ id: 'T3' }],
    });
    expect(missingText.error).toBe('T3 requires text when creating a task');
  });

  it('removes multiple ids atomically and permits removing a dependency with its dependent', () => {
    mutate(store, 'todo_update', {
      changes: [
        { id: 'T1', text: 'root' },
        { id: 'T2', text: 'dependent', depends_on: ['T1'] },
        { id: 'T3', text: 'unrelated' },
      ],
    });
    const blocked = mutate(store, 'todo_remove', { ids: ['T1'] });
    expect(blocked.error).toContain('T2');
    expect(store.state.tasks).toHaveLength(3);

    expect(mutate(store, 'todo_remove', { ids: ['T1', 'T2'] })).toMatchObject({
      changed: true,
    });
    expect(store.state.tasks.map((task) => task.id)).toEqual(['T3']);
  });

  it('rolls back state when persistence fails', () => {
    expect(() =>
      applyMutation(
        store,
        {
          appendEntry: () => {
            throw new Error('persistence failed');
          },
        } as never,
        { hasUI: false } as never,
        'todo_update',
        { changes: [{ id: 'T1', text: 'work' }] },
      ),
    ).toThrow('persistence failed');
    expect(store.state).toEqual(initialState());
  });
});

describe('todo tool registration', () => {
  it('registers exactly the three model-facing tools', () => {
    const definitions: Array<{ name: string }> = [];
    registerTodoTool(
      {
        registerTool(definition: { name: string }) {
          definitions.push(definition);
        },
        appendEntry() {},
      } as never,
      createTaskStore(),
    );
    expect(definitions.map((definition) => definition.name)).toEqual([
      'todo_list',
      'todo_update',
      'todo_remove',
    ]);
  });

  it('keeps schemas strict and excludes the old action API', () => {
    expect(Value.Check(todoListParamsSchema, {})).toBe(true);
    expect(Value.Check(todoListParamsSchema, { action: 'list' })).toBe(false);
    expect(
      Value.Check(todoUpdateParamsSchema, {
        changes: [{ id: 'T1', text: 'work', depends_on: ['T2'] }],
      }),
    ).toBe(true);
    expect(Value.Check(todoUpdateParamsSchema, { changes: [] })).toBe(false);
    expect(Value.Check(todoRemoveParamsSchema, { ids: ['T1'] })).toBe(true);
    expect(Value.Check(todoRemoveParamsSchema, { ids: [] })).toBe(false);
  });

  it('bounds list output', async () => {
    const localStore = createTaskStore();
    for (let index = 0; index < 100; index++)
      mutate(localStore, 'todo_update', {
        changes: [
          {
            id: `T${index + 1}`,
            text: `task-${index} ${'detail '.repeat(200)}`,
          },
        ],
      });
    let listTool:
      | { execute: (...args: unknown[]) => Promise<unknown> }
      | undefined;
    registerTodoTool(
      {
        registerTool(definition: {
          name: string;
          execute: (...args: unknown[]) => Promise<unknown>;
        }) {
          if (definition.name === 'todo_list') listTool = definition;
        },
        appendEntry() {},
      } as never,
      localStore,
    );
    const response = (await listTool?.execute(
      'list',
      {},
      undefined,
      undefined,
      { hasUI: false },
    )) as { content?: Array<{ text?: string }> } | undefined;
    const output = response?.content?.[0]?.text ?? '';
    expect(output.length).toBeLessThanOrEqual(MAX_TODO_RESULT_CHARS);
    expect(output).toContain('more tasks omitted');
  });
});
