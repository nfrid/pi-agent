import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { strictToolArgumentError } from '../tool-argument-validation';
import {
  ListParameters,
  PeekParameters,
  StartParameters,
  StopParameters,
  UnwatchParameters,
  WatchParameters,
} from './schema';

describe('background tool parameters', () => {
  it('uses six focused closed object schemas', () => {
    for (const schema of [
      StartParameters,
      PeekParameters,
      ListParameters,
      StopParameters,
      WatchParameters,
      UnwatchParameters,
    ]) {
      const serialized = JSON.parse(JSON.stringify(schema)) as {
        type?: string;
        additionalProperties?: boolean;
      };
      expect(serialized.type).toBe('object');
      expect(serialized.additionalProperties).toBe(false);
    }
  });

  it('keeps each operation independent and rejects irrelevant fields', () => {
    expect(Value.Check(StartParameters, { command: 'npm run dev' })).toBe(true);
    expect(
      strictToolArgumentError(
        'background_start',
        { command: 'true' },
        StartParameters,
      ),
    ).toBeUndefined();
    expect(
      strictToolArgumentError(
        'background_peek',
        { id: 'bg-1', command: 'wrong operation field' },
        PeekParameters,
      ),
    ).toBe(
      'Tool "background_peek" does not support argument "command". Remove it and retry.',
    );
    expect(Value.Check(PeekParameters, { id: 'bg-1', wait_seconds: 1 })).toBe(
      false,
    );
    expect(Value.Check(ListParameters, { id: 'wrong operation field' })).toBe(
      false,
    );
  });

  it('validates watch bounds and preserves optional start watches', () => {
    const watch = { contains: 'ready', stream: 'stdout', timeout_seconds: 60 };
    expect(
      Value.Check(StartParameters, { command: 'server', watch: [watch] }),
    ).toBe(true);
    expect(Value.Check(WatchParameters, { id: 'bg-1', watch: [watch] })).toBe(
      true,
    );
    expect(
      Value.Check(WatchParameters, { id: 'bg-1', watch: [{ contains: '' }] }),
    ).toBe(false);
    expect(
      Value.Check(WatchParameters, {
        id: 'bg-1',
        watch: [{ contains: 'a\nb' }],
      }),
    ).toBe(false);
    expect(
      Value.Check(WatchParameters, {
        id: 'bg-1',
        watch: [{ contains: 'a', timeout_seconds: 0 }],
      }),
    ).toBe(false);
    expect(
      Value.Check(WatchParameters, {
        id: 'bg-1',
        watch: [{ contains: 'a', timeout_seconds: 86401 }],
      }),
    ).toBe(false);
    expect(
      Value.Check(WatchParameters, {
        id: 'bg-1',
        watch: [{ contains: 'a'.repeat(513) }],
      }),
    ).toBe(false);
    expect(
      Value.Check(StartParameters, {
        command: 'server',
        watch: Array.from({ length: 9 }, () => ({ contains: 'a' })),
      }),
    ).toBe(false);
  });

  it('rejects trailing line breaks as well as embedded ones', () => {
    for (const contains of ['ready\n', 'ready\r', 'ready\r\n']) {
      expect(
        Value.Check(WatchParameters, {
          id: 'bg-1',
          watch: [{ contains }],
        }),
      ).toBe(false);
    }
  });

  it('requires fields for controls and allows an empty list request', () => {
    expect(Value.Check(ListParameters, {})).toBe(true);
    expect(Value.Check(StopParameters, { ids: ['bg-1'] })).toBe(true);
    expect(
      Value.Check(UnwatchParameters, { id: 'bg-1', watch_ids: ['w-1'] }),
    ).toBe(true);
    expect(Value.Check(StopParameters, { ids: [] })).toBe(false);
    expect(Value.Check(UnwatchParameters, { id: 'bg-1', watch_ids: [] })).toBe(
      false,
    );
  });
});
