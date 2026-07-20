import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
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
import { operationSchema, paramsSchema } from './model';
import { applyMutation, mutate, mutateBatch } from './mutations';
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

function result(id: number): TodoContextMessages[number] {
  return {
    role: 'toolResult',
    toolCallId: `call-${id}`,
    toolName: 'todo',
    content: [{ type: 'text', text: `exact-${id}` }],
    isError: false,
    timestamp: id,
  } as TodoContextMessages[number];
}

function text(message: TodoContextMessages[number]): string | undefined {
  if (!('content' in message) || !Array.isArray(message.content))
    return undefined;
  const part = message.content[0];
  return part?.type === 'text' ? part.text : undefined;
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
  it('wires turn snapshots and compact/tree recovery unconditionally', () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;

    registerTodoContext(pi, store);

    expect([...handlers.keys()].sort()).toEqual([
      'before_agent_start',
      'context',
      'session_compact',
      'session_start',
      'session_tree',
    ]);
    const turnStart = handlers.get('before_agent_start')?.() as {
      message: { customType: string; content: string };
    };
    expect(turnStart.message.customType).toBe(TODO_SNAPSHOT_TYPE);
    expect(turnStart.message.content).toContain(
      'Todo state at the start of this user turn',
    );

    handlers.get('session_compact')?.();
    const contextualized = handlers.get('context')?.({
      messages: [snapshot('persisted', 1), result(1)],
    }) as { messages: TodoContextMessages };
    expect(contextualized.messages[0]).toEqual(snapshot('persisted', 1));
    expect(contextualized.messages.at(-1)).toMatchObject({
      role: 'custom',
      customType: TODO_SNAPSHOT_TYPE,
    });
  });
});

describe('atomic todo mutations', () => {
  beforeEach(() => {
    store = createTaskStore();
    applySnapshot(store, initialState());
  });

  it('isolates mutable state between extension-owned stores', () => {
    const other = createTaskStore();
    expect(
      mutate(store, 'add', { action: 'add', id: 'T1', text: 'first' }),
    ).toMatchObject({ changed: true });
    expect(
      mutate(other, 'add', { action: 'add', id: 'T1', text: 'second' }),
    ).toMatchObject({ changed: true });
    expect(store.state.tasks[0]?.text).toBe('first');
    expect(other.state.tasks[0]?.text).toBe('second');
  });

  it('rolls back fields changed before invalid dependency validation', () => {
    expect(
      mutate(store, 'add', { action: 'add', id: 'T1', text: 'original' }),
    ).toMatchObject({
      changed: true,
    });
    const before = cloneState(store);
    const stateReference = store.state;

    const result = mutate(store, 'update', {
      action: 'update',
      id: 'T1',
      text: 'leaked change',
      status: 'doing',
      depends_on: ['missing'],
    });

    expect(result).toMatchObject({
      changed: false,
      error: 'unknown dependencies: missing',
    });
    expect(cloneState(store)).toEqual(before);
    expect(store.state).toBe(stateReference);
  });

  it('rejects cycles from update, replace, and transactional batches', () => {
    expect(
      mutate(store, 'replace', {
        action: 'replace',
        tasks: [
          { id: 'T1', text: 'one', depends_on: [] },
          { id: 'T2', text: 'two', depends_on: ['T1'] },
        ],
      }),
    ).toMatchObject({ changed: true });
    const before = cloneState(store);

    expect(
      mutate(store, 'update', {
        action: 'update',
        id: 'T1',
        depends_on: ['T2'],
      }),
    ).toMatchObject({
      changed: false,
      error: expect.stringContaining('dependency cycle:'),
    });
    expect(cloneState(store)).toEqual(before);

    expect(
      mutate(store, 'replace', {
        action: 'replace',
        tasks: [
          { id: 'T1', text: 'one', depends_on: ['T2'] },
          { id: 'T2', text: 'two', depends_on: ['T1'] },
        ],
      }),
    ).toMatchObject({
      changed: false,
      error: expect.stringContaining('cycle'),
    });
    expect(cloneState(store)).toEqual(before);

    expect(
      mutateBatch(store, [
        { action: 'add', id: 'T3', text: 'three', depends_on: ['T2'] },
        { action: 'update', id: 'T1', depends_on: ['T3'] },
      ]),
    ).toMatchObject({
      changed: false,
      error: expect.stringContaining('cycle'),
    });
    expect(cloneState(store)).toEqual(before);
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
          tool = value;
        },
        appendEntry() {},
      } as unknown as ExtensionAPI,
      store,
    );

    await expect(
      tool?.execute(
        'invalid',
        { action: 'update', id: 'missing', text: 'nope' },
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
          tool = value;
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
        { action: 'add', text: 'must roll back' },
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
        'add',
        { action: 'add', text: 'must not leak' },
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
      applyMutation(store, pi, ctx, 'add', {
        action: 'add',
        text: 'must be compensated',
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
          tool = value;
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
        'add',
        { action: 'add', text: 'must be compensated' },
        new AbortController().signal,
        undefined,
        ctx,
      ),
    ).rejects.toThrow('tool UI failed');
    expect(store.state).toEqual(initialState());
    expect(persisted).toEqual([]);
  });

  it('rolls back every operation and id allocation when a batch fails', () => {
    const before = cloneState(store);

    const result = mutateBatch(store, [
      { action: 'add', text: 'temporary' },
      { action: 'update', id: 'T1', depends_on: ['missing'] },
    ]);

    expect(result.changed).toBe(false);
    expect(result.error).toBe('unknown dependencies: missing');
    expect(cloneState(store)).toEqual(before);
    expect(mutate(store, 'add', { action: 'add', text: 'real' }).message).toBe(
      'added T1',
    );
  });
});

describe('todo widget lifecycle', () => {
  beforeEach(() => {
    store = createTaskStore();
    applySnapshot(store, initialState());
  });

  it('records every completion outside render and renders without mutation', () => {
    mutate(store, 'replace', {
      action: 'replace',
      tasks: Array.from({ length: 15 }, (_, index) => ({
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
    const widget = widgetFactory?.({}, theme);

    expect(widget?.render(100)).toEqual(widget?.render(100));
    expect([...store.completedPendingHide]).toEqual(pending);
    expect([...store.hiddenCompleted]).toEqual(hidden);
  });
});

describe('batch operation schema', () => {
  it('accepts current non-batch operations and rejects malformed/nested calls', () => {
    expect(
      Value.Check(paramsSchema, {
        action: 'batch',
        operations: [
          { action: 'done', id: 'T1' },
          { action: 'add', text: 'next', priority: 'high' },
        ],
      }),
    ).toBe(true);
    expect(Value.Check(operationSchema, { id: 'T1' })).toBe(false);
    expect(
      Value.Check(operationSchema, { action: 'batch', operations: [] }),
    ).toBe(false);
    expect(Value.Check(operationSchema, { action: 'done', id: 1 })).toBe(false);
    expect(
      Value.Check(operationSchema, {
        action: 'done',
        id: 'T1',
        surprise: true,
      }),
    ).toBe(false);
  });

  it('is smaller than a discriminated per-action union while adding validation over Any', () => {
    const actions = [
      'list',
      'add',
      'update',
      'start',
      'done',
      'block',
      'drop',
      'remove',
      'clear_done',
      'replace',
    ] as const;
    const union = Type.Union(
      actions.map((action) =>
        Type.Object({
          action: Type.Literal(action),
          id: Type.Optional(Type.String()),
          text: Type.Optional(Type.String()),
          status: Type.Optional(
            StringEnum([
              'todo',
              'doing',
              'blocked',
              'done',
              'dropped',
            ] as const),
          ),
          depends_on: Type.Optional(Type.Array(Type.String())),
          notes: Type.Optional(Type.String()),
        }),
      ),
    );
    const oldAny = Type.Array(Type.Any());
    const compactBytes = JSON.stringify(operationSchema).length;

    expect(compactBytes).toBeLessThan(JSON.stringify(union).length);
    expect(compactBytes).toBeGreaterThan(JSON.stringify(oldAny).length);
    expect(compactBytes).toBeLessThan(1_500);
  });
});
