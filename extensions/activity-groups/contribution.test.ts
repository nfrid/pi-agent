import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { projectActivityGroups } from '../../packages/activity-model/src/index.js';
import { ActivityGroupsViewModelSchema } from './contribution';

describe('activity groups contribution schema', () => {
  it('accepts a preparing shared projection as renderer input', () => {
    const [group] = projectActivityGroups([
      { kind: 'assistant', speaks: false, streaming: true },
      { kind: 'tool', name: 'read', args: {} },
    ]);
    expect(group?.status).toBe('preparing');
    expect(
      Value.Check(ActivityGroupsViewModelSchema, {
        id: group?.id,
        start: group?.start,
        end: group?.end,
        title: group?.title,
        status: group?.status,
        expanded: group?.expanded,
        toolCount: group?.toolCount,
      }),
    ).toBe(true);
  });
});
