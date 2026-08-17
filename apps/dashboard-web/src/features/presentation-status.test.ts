import { describe, expect, it } from 'vitest';
import { dashboardStatus } from './presentation-status';

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: 'runtime-1',
    liveState: 'working',
    online: true,
    cwd: '/tmp',
    session: { id: 'session-1', entries: [] },
    pendingInteractions: [],
    ...overrides,
  } as never;
}

const waitingSurface = (count: number) => ({
  id: 'runtime.settled-background',
  rendererId: 'runtime.settled-background',
  viewModel: { version: 1, count },
});

describe('dashboard presentation status', () => {
  it('prioritizes input over explicit settled background waiting', () => {
    expect(
      dashboardStatus(
        runtime({
          pendingInteractions: [{ id: 'question-1' }],
          extensionSurfaces: [waitingSurface(2)],
        }),
      ),
    ).toEqual({ status: 'input', label: 'input' });
  });

  it('shows compact singular and plural waiting labels over raw working state', () => {
    expect(
      dashboardStatus(runtime({ extensionSurfaces: [waitingSurface(1)] })),
    ).toEqual({ status: 'waiting', label: 'waiting' });
    expect(
      dashboardStatus(runtime({ extensionSurfaces: [waitingSurface(3)] })),
    ).toEqual({ status: 'waiting', label: 'waiting (3)' });
  });

  it('preserves ordinary working status without the explicit surface', () => {
    expect(dashboardStatus(runtime())).toEqual({
      status: 'working',
      label: 'working',
    });
  });
});
