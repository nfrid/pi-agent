import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { isGenuineAgentSettlement } from './agent-lifecycle';
import {
  getScopedServices,
  releaseScopedServices,
  type ScopedServices,
} from './scoped-services';

const scopes = new Set<string>();

function services(name: string): ScopedServices {
  scopes.add(name);
  return getScopedServices(name);
}

afterEach(() => {
  for (const scope of scopes) releaseScopedServices(scope);
  scopes.clear();
});

describe('scoped runtime services', () => {
  test('does not list or answer another scope interaction', async () => {
    const first = services(`scope-a-${randomUUID()}`);
    const second = services(`scope-b-${randomUUID()}`);
    const pending = first.interactionBroker.request(
      {
        type: 'ask_user',
        question: 'Continue?',
        choices: [{ label: 'Yes', value: 'yes' }],
        allowCustom: false,
      },
      () => new Promise(() => {}),
      undefined,
      first.scopeId,
      60_000,
    );
    const interaction = first.interactionBroker.list()[0];
    expect(interaction).toBeDefined();
    expect(second.interactionBroker.list()).toEqual([]);
    expect(second.interactionBroker.answer(interaction?.id ?? '', 'yes')).toBe(
      false,
    );
    expect(first.interactionBroker.answer(interaction?.id ?? '', 'yes')).toBe(
      true,
    );
    await expect(pending).resolves.toMatchObject({ answer: 'yes' });
  });

  test('keeps live surfaces and pending settlement accounting isolated', () => {
    const first = services(`surface-a-${randomUUID()}`);
    const second = services(`surface-b-${randomUUID()}`);
    first.liveSurfaceHub.publish('tasks', [
      { id: 'tasks.a', rendererId: 'tasks.a', viewModel: { scope: 'a' } },
    ]);
    second.liveSurfaceHub.publish('tasks', [
      { id: 'tasks.b', rendererId: 'tasks.b', viewModel: { scope: 'b' } },
    ]);
    expect(
      first.liveSurfaceHub.snapshot().map((surface) => surface.id),
    ).toEqual(['tasks.a']);
    expect(
      second.liveSurfaceHub.snapshot().map((surface) => surface.id),
    ).toEqual(['tasks.b']);

    const source = {};
    first.pendingProcesses.set(source, 1);
    expect(isGenuineAgentSettlement(false, first.scopeId)).toBe(false);
    expect(isGenuineAgentSettlement(false, second.scopeId)).toBe(true);
  });

  test('late release of an old generation cannot clear its replacement', () => {
    const scope = `replacement-${randomUUID()}`;
    const oldServices = services(scope);
    oldServices.liveSurfaceHub.publish('tasks', [
      { id: 'tasks.old', rendererId: 'tasks.old', viewModel: {} },
    ]);
    expect(releaseScopedServices(scope, oldServices)).toBe(true);
    const replacement = getScopedServices(scope);
    scopes.add(scope);
    replacement.liveSurfaceHub.publish('tasks', [
      { id: 'tasks.new', rendererId: 'tasks.new', viewModel: {} },
    ]);
    expect(releaseScopedServices(scope, oldServices)).toBe(false);
    expect(
      replacement.liveSurfaceHub.snapshot().map((surface) => surface.id),
    ).toEqual(['tasks.new']);
  });
});
