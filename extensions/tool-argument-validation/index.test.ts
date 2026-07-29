import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type TSchema, Type } from 'typebox';
import { describe, expect, test, vi } from 'vitest';
import extension, { strictToolArgumentError } from './index';

describe('strictToolArgumentError', () => {
  test('rejects undeclared root arguments with an actionable error', () => {
    const schema = Type.Object({
      command: Type.String(),
      timeout: Type.Optional(Type.Number()),
    });

    expect(
      strictToolArgumentError(
        'bash',
        { command: 'true', workdir: '/tmp' },
        schema,
      ),
    ).toBe(
      'Tool "bash" does not support argument "workdir". Remove it and retry.',
    );
    expect(
      strictToolArgumentError('bash', { command: 'true' }, schema),
    ).toBeUndefined();
  });

  test('supports plain, record, union, and intersect schemas', () => {
    const plain = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    } as TSchema;
    expect(
      strictToolArgumentError('read', { path: 'file.ts', offset: 1 }, plain),
    ).toContain('offset');

    const record = Type.Record(Type.String(), Type.String());
    expect(
      strictToolArgumentError(
        'headers',
        { accept: 'application/json' },
        record,
      ),
    ).toBeUndefined();

    const union = Type.Union([
      Type.Object({ path: Type.String() }),
      Type.Object({ id: Type.Number() }),
    ]);
    expect(
      strictToolArgumentError('select', { path: 'file.ts' }, union),
    ).toBeUndefined();
    expect(
      strictToolArgumentError(
        'select',
        { path: 'file.ts', workdir: '/tmp' },
        union,
      ),
    ).toContain('workdir');

    const intersect = Type.Intersect([
      Type.Object({ path: Type.String() }),
      Type.Object({ mode: Type.String() }),
    ]);
    expect(
      strictToolArgumentError(
        'operation',
        { path: 'file.ts', mode: 'read' },
        intersect,
      ),
    ).toBeUndefined();
  });

  test('preserves explicit additional-property and nested-object behavior', () => {
    const permissive = Type.Object(
      { name: Type.String() },
      { additionalProperties: true },
    );
    expect(
      strictToolArgumentError(
        'metadata',
        { name: 'example', arbitrary: true },
        permissive,
      ),
    ).toBeUndefined();

    const typedAdditional = {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: { type: 'number' },
    } as TSchema;
    expect(
      strictToolArgumentError(
        'scores',
        { name: 'example', quality: 42 },
        typedAdditional,
      ),
    ).toBeUndefined();
    expect(
      strictToolArgumentError(
        'scores',
        { name: 'example', quality: 'bad' },
        typedAdditional,
      ),
    ).toBe('Tool "scores" arguments do not match its declared schema.');

    const nested = Type.Object({
      options: Type.Object({ enabled: Type.Boolean() }),
    });
    expect(
      strictToolArgumentError(
        'configure',
        { options: { enabled: true, providerOption: 'value' } },
        nested,
      ),
    ).toBeUndefined();
  });
});

test('extension blocks built-in and dynamic tool calls before execution', () => {
  type ToolCallHandler = (event: {
    toolName: string;
    input: unknown;
  }) => Promise<unknown> | unknown;
  let handler: ToolCallHandler | undefined;
  const tools: ReturnType<ExtensionAPI['getAllTools']> = [
    {
      name: 'bash',
      description: 'Run a command',
      parameters: Type.Object({ command: Type.String() }),
      promptGuidelines: [],
      sourceInfo: {
        path: '<builtin:bash>',
        source: 'builtin',
        scope: 'temporary',
        origin: 'top-level',
      },
    },
  ];
  const pi = {
    on(event: string, next: ToolCallHandler) {
      if (event === 'tool_call') handler = next;
    },
    getAllTools: () => tools,
  } as unknown as ExtensionAPI;
  const execute = vi.fn();
  const dispatch = (toolName: string, input: unknown) => {
    const gate = handler?.({ toolName, input });
    if (!gate) execute(toolName, input);
    return gate;
  };

  extension(pi);
  expect(dispatch('bash', { command: 'true', workdir: '/tmp' })).toEqual({
    block: true,
    reason:
      'Tool "bash" does not support argument "workdir". Remove it and retry.',
  });
  expect(execute).not.toHaveBeenCalled();

  expect(dispatch('bash', { command: 'true' })).toBeUndefined();
  expect(execute).toHaveBeenCalledOnce();

  tools.push({
    name: 'custom_search',
    description: 'Search a custom source',
    parameters: Type.Object({ query: Type.String() }),
    promptGuidelines: [],
    sourceInfo: {
      path: '/extensions/custom-search.ts',
      source: 'extension',
      scope: 'user',
      origin: 'top-level',
    },
  });
  expect(dispatch('custom_search', { query: 'pi', unsupported: true })).toEqual(
    {
      block: true,
      reason:
        'Tool "custom_search" does not support argument "unsupported". Remove it and retry.',
    },
  );
  expect(execute).toHaveBeenCalledOnce();
});
