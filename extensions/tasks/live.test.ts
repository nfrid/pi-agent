import { describe, expect, it } from 'vitest';
import { taskSurface } from './live';
import { mutate } from './mutations';
import { applySnapshot, createTaskStore, initialState } from './store';

describe('tasks live surface', () => {
  it('projects current task state and derived stats', () => {
    const store = createTaskStore();
    applySnapshot(store, initialState());
    mutate(store, 'add', {
      action: 'add',
      id: 'T1',
      text: 'Implement live surfaces',
      priority: 'high',
    });

    expect(taskSurface(store)).toMatchObject({
      id: 'tasks.current',
      rendererId: 'tasks.current',
      placement: 'left-rail',
      viewModel: {
        version: 1,
        tasks: [
          {
            id: 'T1',
            text: 'Implement live surfaces',
            status: 'todo',
            dependsOn: [],
            priority: 'high',
          },
        ],
        stats: { total: 1, active: 1, done: 0, blocked: 0, ready: 1 },
      },
    });
  });
});
