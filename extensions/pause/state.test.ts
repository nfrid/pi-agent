import { describe, expect, test } from 'vitest';
import { PauseCoordinator, pauseLabel } from './state';

describe('pause coordinator', () => {
  test('reaches paused only after the main agent and enrolled delegates', async () => {
    const coordinator = new PauseCoordinator();
    const updates: Array<string | undefined> = [];
    coordinator.subscribe((snapshot) => updates.push(snapshot?.phase));

    const requested = coordinator.request();
    coordinator.enrollDelegates(requested.generation, ['one', 'two']);
    coordinator.markMainReached(requested.generation);
    coordinator.markDelegateReached(requested.generation, 'one');
    expect(coordinator.snapshot()?.phase).toBe('pausing');

    coordinator.markDelegateReached(requested.generation, 'two');
    const paused = coordinator.snapshot();
    expect(paused?.phase).toBe('paused');
    expect(paused && pauseLabel(paused)).toBe('Paused (with 2 delegates)');

    coordinator.resume();
    expect(coordinator.snapshot()).toBeUndefined();
    expect(updates).toContain('paused');
  });

  test('blocks a reached boundary until the matching pause resumes', async () => {
    const coordinator = new PauseCoordinator();
    const requested = coordinator.request();
    let released = false;
    const waiting = coordinator.waitForResume(requested.generation).then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(coordinator.snapshot()?.mainReached).toBe(true);
    expect(released).toBe(false);

    coordinator.resume();
    await waiting;
    expect(released).toBe(true);
  });

  test('ignores stale acknowledgements from an older generation', () => {
    const coordinator = new PauseCoordinator();
    const first = coordinator.request();
    coordinator.resume();
    const second = coordinator.request();
    coordinator.enrollDelegates(second.generation, ['current']);
    coordinator.markMainReached(second.generation);
    coordinator.markDelegateReached(first.generation, 'current');
    expect(coordinator.snapshot()?.phase).toBe('pausing');
  });
});
