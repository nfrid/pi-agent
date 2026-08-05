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
          },
        ],
      },
    });
  });
});
