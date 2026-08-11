import { projectActivityGroups } from '@pi-dashboard/activity-model';
import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { ActivityGroupsViewModelSchema } from './contribution';

describe('activity groups contribution schema', () => {
  it('accepts a preparing shared projection as renderer input', () => {
    const [group] = projectActivityGroups([
      {
        kind: 'assistant',
        speaks: false,
        streaming: true,
        title: 'Preparing the work',
        titleKind: 'preamble',
      },
      { kind: 'tool', name: 'read', args: {} },
    ]);
    expect(group?.status).toBe('preparing');
    expect(group).toBeDefined();
    expect(Value.Check(ActivityGroupsViewModelSchema, group)).toBe(true);
  });

  it('bounds opaque tool arguments while retaining the complete view model', () => {
    const [group] = projectActivityGroups([
      {
        kind: 'assistant',
        speaks: false,
        title: 'Read the file',
        titleKind: 'preamble',
      },
      {
        kind: 'tool',
        name: 'read',
        args: { path: '/tmp/file', nested: ['ok'] },
      },
    ]);
    expect(Value.Check(ActivityGroupsViewModelSchema, group)).toBe(true);
    expect(
      Value.Check(ActivityGroupsViewModelSchema, {
        ...group,
        tools: [
          {
            name: 'read',
            args: Object.fromEntries(
              Array.from({ length: 129 }, (_, index) => [`key-${index}`, true]),
            ),
          },
        ],
      }),
    ).toBe(false);
  });
});
