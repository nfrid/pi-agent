import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { setPendingProcessCount } from '../shared/runtime/pending-processes';
import { getScopedServices } from '../shared/runtime/scoped-services';
import notifySound, { shouldNotifyAgentSettled } from './index';

describe('notify sound lifecycle', () => {
  it('does not suppress settlement for a passive running process', () => {
    const source = {};
    setPendingProcessCount(source, 1, 'passive-service');
    try {
      expect(shouldNotifyAgentSettled('passive-service')).toBe(true);
    } finally {
      setPendingProcessCount(source, 0, 'passive-service');
    }
  });

  it('suppresses settlement only while its session has required outcomes', () => {
    const services = getScopedServices('required-outcome');
    let pending = true;
    services.requestDependencies = {
      register: () => true,
      resolveDelegateGate: () => undefined,
      hasPending: () => pending,
    };
    try {
      expect(shouldNotifyAgentSettled('required-outcome')).toBe(false);
      expect(shouldNotifyAgentSettled('unrelated-session')).toBe(true);
      pending = false;
      expect(shouldNotifyAgentSettled('required-outcome')).toBe(true);
    } finally {
      services.requestDependencies = undefined;
    }
  });

  it('uses settled completion and stays inert when focus reporting is not installed', () => {
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const registrations: string[] = [];
    const pi = {
      on(event: string, handler: (...args: never[]) => unknown) {
        registrations.push(event);
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;

    notifySound(pi);
    notifySound(pi);

    expect(registrations).toHaveLength(3);
    expect(handlers.has('agent_settled')).toBe(true);
    expect(handlers.has('agent_end')).toBe(false);
    handlers.get('session_start')?.({} as never, { mode: 'print' } as never);
    expect(() => handlers.get('agent_settled')?.()).not.toThrow();
  });
});
