import { describe, expect, it } from 'vitest';
import { delegateSurface } from './live';
import { DelegateStatusStore } from './status';
import { createRun } from './types';

describe('delegate live surface', () => {
  it('projects the current bounded status lineage for the renderer', () => {
    const store = new DelegateStatusStore();
    const run = createRun('inspect');
    const [id] = store.start([run], 'background');
    run.state = 'running';
    run.activities.push({
      type: 'tool',
      label: 'read source',
      status: 'running',
    });
    store.update(id, run);

    expect(delegateSurface(store)).toMatchObject({
      id: 'delegate.status',
      rendererId: 'delegate.status',
      placement: 'right-rail',
      viewModel: {
        version: 1,
        statuses: [
          {
            id,
            name: 'Subagent',
            state: 'running',
            activity: { label: 'read source' },
            transcript: [
              { type: 'task', label: 'Task', text: 'inspect' },
              { type: 'tool', label: 'read source' },
            ],
          },
        ],
      },
    });
  });

  it('prioritizes active work and bounds historical dashboard payloads', () => {
    const store = new DelegateStatusStore();
    const active = createRun('active task');
    const [activeId] = store.start([active], 'background');
    active.state = 'running';
    store.update(activeId, active);

    for (let index = 0; index < 30; index += 1) {
      const run = createRun(`historical task ${index}`);
      run.queuedAt = (active.queuedAt ?? 0) + index + 1;
      const [id] = store.start([run], 'background');
      run.state = 'success';
      run.finishedAt = Date.now() + index;
      store.update(id, run);
    }

    const statuses = (
      delegateSurface(store).viewModel as {
        statuses: Array<{ id: string; state: string }>;
      }
    ).statuses;
    expect(statuses).toHaveLength(24);
    expect(statuses[0]).toMatchObject({ id: activeId, state: 'running' });
    expect(statuses.some((status) => status.id === 'ds-2')).toBe(false);
  });
});
