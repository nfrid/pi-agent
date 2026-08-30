import { describe, expect, it } from 'vitest';
import { dashboardStatus } from './presentation-status';

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: 'runtime-1',
    liveState: 'working',
    online: true,
    cwd: '/tmp',
    session: { id: 'session-1', entries: [] },
    ...overrides,
  } as never;
}

const waitingSurface = (count: number) => ({
  id: 'runtime.settled-background',
  rendererId: 'runtime.settled-background',
  viewModel: { version: 1, count },
});

describe('dashboard presentation status', () => {
  it('uses waiting labels for settled background work without user input', () => {
    expect(
      dashboardStatus(runtime({ extensionSurfaces: [waitingSurface(1)] })),
    ).toEqual({ status: 'waiting', label: 'waiting' });
    expect(
      dashboardStatus(runtime({ extensionSurfaces: [waitingSurface(3)] })),
    ).toEqual({ status: 'waiting', label: 'waiting · 3' });
  });

  it('labels idle and absent runtimes as ready', () => {
    expect(dashboardStatus(undefined)).toEqual({
      status: 'dormant',
      label: 'ready',
    });
    expect(dashboardStatus(runtime({ liveState: 'idle' }))).toEqual({
      status: 'idle',
      label: 'ready',
    });
  });

  it('preserves ordinary working status without the explicit surface', () => {
    expect(dashboardStatus(runtime())).toEqual({
      status: 'working',
      label: 'working',
    });
  });
});
