import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { Parameters } from './schema';

describe('background tool parameters', () => {
  it('accepts only the fields relevant to each action', () => {
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

    expect(
      Value.Check(Parameters, { action: 'start', title: 'missing command' }),
    ).toBe(false);
    expect(Value.Check(Parameters, { action: 'peek' })).toBe(false);
    expect(Value.Check(Parameters, { action: 'stop', ids: [] })).toBe(false);
    expect(
      Value.Check(Parameters, {
        action: 'start',
        command: 'true',
        title: 'server',
        id: 'bg-1',
      }),
    ).toBe(false);
    expect(Value.Check(Parameters, { action: 'list', command: 'true' })).toBe(
      false,
    );
  });

  it('describes the behavior of every discriminated action branch', () => {
    const branches = (
      Parameters as {
        anyOf: Array<{
          properties: { action: { description?: string } };
        }>;
      }
    ).anyOf;
    expect(branches).toHaveLength(4);
    expect(
      branches.map((branch) => branch.properties.action.description),
    ).toEqual([
      expect.stringContaining('Start'),
      expect.stringContaining('Inspect'),
      expect.stringContaining('List'),
      expect.stringContaining('Stop'),
    ]);
  });
});
