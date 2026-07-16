import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import {
  EXACT_TODO_RESULT_PREFIX,
  TODO_RESULT_ELIDED,
  TODO_SNAPSHOT_TYPE,
  type TodoContextMessages,
  transformTodoContext,
} from './context';
import { turnSnapshotText } from './format';
import { operationSchema, paramsSchema } from './schema';
import { registerTodoContext } from './tool';

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
    const content = turnSnapshotText();
    expect(content).toContain('Todo state at the start of this user turn');
    expect(content).toContain('Later todo tool results and later snapshots');
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

    registerTodoContext(pi);

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
