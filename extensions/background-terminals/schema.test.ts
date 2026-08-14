import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { Parameters } from './schema';

describe('background tool parameters', () => {
  it('accepts each action and enforces unconditional limits', () => {
    expect(
      Value.Check(Parameters, {
        action: 'start',
        command: 'npm run dev',
        title: 'dev server',
      }),
    ).toBe(true);
    expect(
      Value.Check(Parameters, {
        action: 'peek',
        id: 'bg-1',
        wait_seconds: 2,
        tail_lines: 20,
      }),
    ).toBe(true);
    expect(Value.Check(Parameters, { action: 'list' })).toBe(true);
    expect(
      Value.Check(Parameters, { action: 'stop', ids: ['bg-1', 'bg-2'] }),
    ).toBe(true);

    expect(Value.Check(Parameters, { action: 'stop', ids: [] })).toBe(false);
    expect(Value.Check(Parameters, { action: 'unknown' })).toBe(false);
    expect(Value.Check(Parameters, { action: 'list', unsupported: true })).toBe(
      false,
    );
  });

  it('describes action behavior and conditional requirements', () => {
    const description = (schema: unknown) =>
      (schema as { description?: string }).description;
    const properties = Parameters.properties;
    expect(description(properties.action)).toContain(
      'start launches a process',
    );
    expect(description(properties.action)).toContain(
      'peek inspects one process',
    );
    expect(description(properties.action)).toContain(
      'list shows retained processes',
    );
    expect(description(properties.action)).toContain('stop terminates');
    expect(description(properties.command)).toContain('Required for start');
    expect(description(properties.title)).toContain('Required for start');
    expect(description(properties.id)).toContain('Required for peek');
    expect(description(properties.ids)).toContain('Required for stop');
  });
});
