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

  it('keeps the active task in bounded dashboard rows', () => {
    const store = createTaskStore();
    applySnapshot(store, initialState());
    for (let index = 1; index <= 129; index += 1)
      mutate(store, 'add', {
        action: 'add',
        id: `T${index}`,
        text: `Task ${index}`,
      });
    mutate(store, 'start', { action: 'start', id: 'T129' });

    const surface = taskSurface(store);
    const viewModel = surface.viewModel as {
      tasks: readonly { id: string; status: string }[];
      stats: { total: number };
    };
    expect(viewModel.tasks).toHaveLength(128);
    expect(viewModel.tasks[0]).toMatchObject({ id: 'T129', status: 'doing' });
    expect(viewModel.stats.total).toBe(129);
  });
});
