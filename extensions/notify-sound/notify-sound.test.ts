import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { setPendingProcessCount } from '../shared/runtime/pending-processes';
import notifySound, { shouldNotifyAgentSettled } from './index';

describe('notify sound lifecycle', () => {
  it('suppresses settled notification while a process is pending', () => {
    const source = {};
    setPendingProcessCount(source, 1);
    try {
      expect(shouldNotifyAgentSettled()).toBe(false);
    } finally {
      setPendingProcessCount(source, 0);
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
