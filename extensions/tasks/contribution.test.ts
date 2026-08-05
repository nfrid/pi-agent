import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import {
  TASKS_RENDERER_ID,
  TaskStateViewModelSchema,
  tasksCapabilitySnapshot,
  tasksManifest,
} from './contribution';

describe('tasks live contribution', () => {
  it('advertises a typed renderer and validates current task state', () => {
    expect(tasksManifest.renderers.map((renderer) => renderer.id)).toEqual([
      TASKS_RENDERER_ID,
    ]);
    expect(tasksCapabilitySnapshot.manifests[0]?.renderers[0]?.id).toBe(
      TASKS_RENDERER_ID,
    );
    expect(
      Value.Check(TaskStateViewModelSchema, {
        version: 1,
        tasks: [
          {
            id: 'T1',
            text: 'Implement surface',
            status: 'doing',
            dependsOn: [],
            priority: 'normal',
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        stats: { total: 1, active: 1, done: 0, blocked: 0, ready: 0 },
      }),
    ).toBe(true);
  });
});
