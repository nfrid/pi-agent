import { describe, expect, test } from 'vitest';
import {
  boundedWorkflowName,
  normalizePreparedLaunch,
  validatePreparedLaunch,
  validateScheduleInput,
  validProcessLink,
} from './workflow-launch-policy';

const execute = async () => ({
  runs: [],
  handoff: 'done',
});

const launch = {
  mode: 'single' as const,
  tasks: ['work'],
  execute,
};

describe('workflow launch policy', () => {
  test('normalizes bare and prepared launch results without changing identity', () => {
    expect(normalizePreparedLaunch(launch)).toEqual({ launch });
    const discard = () => {};
    const prepared = { launch, discard };
    expect(normalizePreparedLaunch(prepared)).toBe(prepared);
  });

  test.each([
    [undefined, 'Lazy workflow launch factory must return job options.'],
    [
      { mode: 'invalid', tasks: ['work'], execute },
      'Lazy workflow launch factory returned an invalid mode.',
    ],
    [
      { mode: 'single', tasks: ['work', 1], execute },
      'Lazy workflow launch factory returned invalid tasks.',
    ],
    [
      { mode: 'single', tasks: ['work'] },
      'Lazy workflow launch factory returned no execute function.',
    ],
  ])('preserves prepared launch validation error for %j', (value, error) => {
    expect(() => validatePreparedLaunch(value)).toThrow(error);
  });

  test('accepts a complete prepared launch', () => {
    expect(() => validatePreparedLaunch(launch)).not.toThrow();
  });

  test('parameterizes schedule dependency bounds and retains route errors', () => {
    expect(() =>
      validateScheduleInput(
        {
          logicalId: 'work',
          after: ['a', 'b'],
          mode: 'single',
          tasks: ['work'],
          execute,
        },
        1,
      ),
    ).toThrow(
      'A workflow attempt may declare at most 1 explicit dependencies.',
    );
    expect(() =>
      validateScheduleInput({
        logicalId: 'work',
        route: 1,
        mode: 'single',
        tasks: ['work'],
        execute,
      } as never),
    ).toThrow('Invalid delegate route.');
  });

  test('bounds names and validates hosted process links independently', () => {
    expect(boundedWorkflowName('  a very long name  ', 'fallback', 5)).toBe(
      'a ver',
    );
    expect(boundedWorkflowName('bad\nname', 'fallback', 5)).toBe('fallback');
    expect(validProcessLink(undefined, undefined)).toBe(true);
    expect(validProcessLink('child-session', undefined)).toBe(false);
    expect(
      validProcessLink('child-session', '123e4567-e89b-42d3-a456-426614174000'),
    ).toBe(true);
  });
});
