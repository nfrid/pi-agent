import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { strictToolArgumentError } from '../tool-argument-validation';
import { Parameters } from './schema';

describe('background tool parameters', () => {
  it('uses a closed object root with action-specific branches', () => {
    const serialized = JSON.parse(JSON.stringify(Parameters)) as {
      type?: string;
      required?: string[];
      additionalProperties?: boolean;
      oneOf?: unknown[];
    };
    expect(serialized.type).toBe('object');
    expect(serialized.required).toEqual(['action']);
    expect(serialized.additionalProperties).toBe(false);
    expect(serialized.oneOf).toHaveLength(6);
  });

  it('accepts defaults and rejects irrelevant or unsupported fields', () => {
    expect(
      Value.Check(Parameters, {
        action: 'start',
        command: 'npm run dev',
      }),
    ).toBe(true);
    expect(
      strictToolArgumentError(
        'background',
        { action: 'start', command: 'true' },
        Parameters,
      ),
    ).toBeUndefined();
    expect(
      strictToolArgumentError(
        'background',
        { action: 'peek', id: 'bg-1', command: 'wrong action field' },
        Parameters,
      ),
    ).toBe('Tool "background" arguments do not match its declared schema.');
    expect(
      Value.Check(Parameters, { action: 'peek', id: 'bg-1', wait_seconds: 1 }),
    ).toBe(false);
    expect(
      Value.Check(Parameters, { action: 'list', id: 'wrong action field' }),
    ).toBe(false);
  });

  it('validates watch bounds and preserves optional start watches', () => {
    const watch = { contains: 'ready', stream: 'stdout', timeout_seconds: 60 };
    expect(
      Value.Check(Parameters, {
        action: 'start',
        command: 'server',
        watch: [watch],
      }),
    ).toBe(true);
    expect(
      Value.Check(Parameters, { action: 'watch', id: 'bg-1', watch: [watch] }),
    ).toBe(true);
    expect(
      Value.Check(Parameters, {
        action: 'watch',
        id: 'bg-1',
        watch: [{ contains: '' }],
      }),
    ).toBe(false);
    expect(
      Value.Check(Parameters, {
        action: 'watch',
        id: 'bg-1',
        watch: [{ contains: 'a\nb' }],
      }),
    ).toBe(false);
    expect(
      Value.Check(Parameters, {
        action: 'watch',
        id: 'bg-1',
        watch: [{ contains: 'a', timeout_seconds: 0 }],
      }),
    ).toBe(false);
    expect(
      Value.Check(Parameters, {
        action: 'watch',
        id: 'bg-1',
        watch: [{ contains: 'a', timeout_seconds: 86401 }],
      }),
    ).toBe(false);
    expect(
      Value.Check(Parameters, {
        action: 'watch',
        id: 'bg-1',
        watch: [{ contains: 'a'.repeat(513) }],
      }),
    ).toBe(false);
    expect(
      Value.Check(Parameters, {
        action: 'start',
        command: 'server',
        watch: Array.from({ length: 9 }, () => ({ contains: 'a' })),
      }),
    ).toBe(false);
  });

  it('rejects trailing line breaks as well as embedded ones', () => {
    for (const contains of ['ready\n', 'ready\r', 'ready\r\n']) {
      expect(
        Value.Check(Parameters, {
          action: 'watch',
          id: 'bg-1',
          watch: [{ contains }],
        }),
      ).toBe(false);
    }
  });

  it('requires only fields relevant to each action', () => {
    expect(Value.Check(Parameters, { action: 'list' })).toBe(true);
    expect(Value.Check(Parameters, { action: 'stop', ids: ['bg-1'] })).toBe(
      true,
    );
    expect(
      Value.Check(Parameters, {
        action: 'unwatch',
        id: 'bg-1',
        watch_ids: ['w-1'],
      }),
    ).toBe(true);
    expect(Value.Check(Parameters, { action: 'stop', ids: [] })).toBe(false);
    expect(
      Value.Check(Parameters, { action: 'unwatch', id: 'bg-1', watch_ids: [] }),
    ).toBe(false);
  });
});
