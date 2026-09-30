import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { setPendingProcessCount } from '../shared/runtime/pending-processes';
import { getScopedServices } from '../shared/runtime/scoped-services';
import { liveState } from './runtime-snapshot-adapter';

const scope = `waiting-test-${Math.random().toString(36).slice(2)}`;
const source = {};

afterEach(() => {
  setPendingProcessCount(source, 0, scope);
  getScopedServices(scope).requestDependencies = undefined;
});

describe('runtime live state', () => {
  it('reports waiting for required outcomes, not passive process activity', () => {
    const idle = {
      isIdle: () => true,
      sessionManager: { getSessionId: () => scope },
    } as unknown as ExtensionContext;
    setPendingProcessCount(source, 1, scope);
    expect(liveState(idle)).toBe('idle');
    getScopedServices(scope).requestDependencies = {
      register: () => true,
      resolveDelegateGate: () => {},
      hasPending: () => true,
    };
    expect(liveState(idle)).toBe('waiting');

    const working = {
      ...idle,
      isIdle: () => false,
    } as unknown as ExtensionContext;
    expect(liveState(working)).toBe('working');
    setPendingProcessCount(source, 0, scope);
    expect(liveState(idle)).toBe('waiting');
    getScopedServices(scope).requestDependencies = undefined;
    expect(liveState(idle)).toBe('idle');
  });
});
