import { afterEach, describe, expect, test } from 'vitest';
import {
  beginsFreshUserTurn,
  isGenuineAgentSettlement,
  markDashboardFreshUserTurn,
} from './agent-lifecycle';
import { setPendingProcessCount } from './pending-processes';
import { getScopedServices } from './scoped-services';

const source = {};

afterEach(() => {
  setPendingProcessCount(source, 0);
  getScopedServices().requestDependencies = undefined;
});

describe('shared agent lifecycle policy', () => {
  test('recognizes settlement only after shared and caller-local work ends', () => {
    expect(isGenuineAgentSettlement()).toBe(true);
    expect(isGenuineAgentSettlement(true)).toBe(false);

    setPendingProcessCount(source, 1);
    expect(isGenuineAgentSettlement()).toBe(true);
    getScopedServices().requestDependencies = {
      register: () => undefined,
      resolveDelegateGate: () => undefined,
      hasPending: () => true,
    };
    expect(isGenuineAgentSettlement()).toBe(false);
  });

  test('recognizes only a fresh idle user turn', () => {
    expect(beginsFreshUserTurn({ source: 'interactive' })).toBe(true);
    expect(beginsFreshUserTurn({ source: 'rpc' })).toBe(true);
    expect(beginsFreshUserTurn({ source: 'extension' })).toBe(false);
    markDashboardFreshUserTurn('dashboard');
    expect(
      beginsFreshUserTurn(
        { source: 'extension', streamingBehavior: 'followUp' },
        'dashboard',
      ),
    ).toBe(false);
    expect(beginsFreshUserTurn({ source: 'extension' }, 'dashboard')).toBe(
      true,
    );
    expect(beginsFreshUserTurn({ source: 'extension' }, 'dashboard')).toBe(
      false,
    );
    const cancelDashboardTurn = markDashboardFreshUserTurn('cancelled');
    cancelDashboardTurn();
    expect(beginsFreshUserTurn({ source: 'extension' }, 'cancelled')).toBe(
      false,
    );
    expect(
      beginsFreshUserTurn({
        source: 'interactive',
        streamingBehavior: 'steer',
      }),
    ).toBe(false);
    expect(
      beginsFreshUserTurn({
        source: 'interactive',
        streamingBehavior: 'followUp',
      }),
    ).toBe(false);

    setPendingProcessCount(source, 1);
    expect(beginsFreshUserTurn({ source: 'interactive' })).toBe(true);
    const services = getScopedServices();
    let waiting = true;
    services.requestDependencies = {
      register: () => undefined,
      resolveDelegateGate: () => undefined,
      hasPending: () => waiting,
    };
    expect(beginsFreshUserTurn({ source: 'interactive' })).toBe(false);
    markDashboardFreshUserTurn();
    expect(beginsFreshUserTurn({ source: 'extension' })).toBe(false);
    waiting = false;
    expect(beginsFreshUserTurn({ source: 'extension' })).toBe(false);
    services.requestDependencies = undefined;
  });
});
