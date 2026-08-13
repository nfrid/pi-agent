import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import { runtimeLifecycleActionAvailability } from './runtime-actions';

function runtime(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    runtimeId: 'runtime-1',
    ownership: 'external',
    pid: 1,
    cwd: '/tmp/project',
    liveState: 'working',
    online: true,
    session: { id: 'session-1', entries: [] },
    pendingInteractions: [],
    ...overrides,
  } as RuntimeSnapshot;
}

describe('runtime lifecycle action availability', () => {
  it('offers graceful stop without exposing force stop initially', () => {
    expect(runtimeLifecycleActionAvailability(runtime())).toEqual({
      canStop: true,
      canRestart: false,
      canForceStop: false,
    });
  });

  it('only exposes force stop after failure or an explicit stopping state', () => {
    expect(runtimeLifecycleActionAvailability(runtime(), true)).toEqual({
      canStop: false,
      canRestart: false,
      canForceStop: true,
    });
    expect(
      runtimeLifecycleActionAvailability(runtime({ liveState: 'stopping' })),
    ).toEqual({ canStop: false, canRestart: false, canForceStop: true });
  });

  it('keeps restart available for managed runtimes, including offline ones', () => {
    expect(
      runtimeLifecycleActionAvailability(
        runtime({ ownership: 'managed', online: false }),
      ),
    ).toEqual({ canStop: false, canRestart: true, canForceStop: false });
  });
});
