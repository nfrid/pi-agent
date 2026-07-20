import { describe, expect, it, vi } from 'vitest';
import { createLifecycleGuard } from './lifecycle-guard';

describe('createLifecycleGuard', () => {
  it('rejects work started before a lifecycle bump', () => {
    const lifecycle = createLifecycleGuard();
    const assertCurrent = lifecycle.guard();
    const handlers = new Map<string, () => void>();
    lifecycle.register({
      on: vi.fn((event: string, handler: () => void) => {
        handlers.set(event, handler);
      }),
    } as never);

    handlers.get('session_shutdown')?.();
    expect(() => assertCurrent()).toThrow(
      'Operation crossed a session lifecycle boundary.',
    );
  });

  it('runs session hooks after bumping generation', () => {
    const onSessionStart = vi.fn();
    const lifecycle = createLifecycleGuard({ onSessionStart });
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    lifecycle.register({
      on: vi.fn(
        (event: string, handler: (event: unknown, ctx: unknown) => void) => {
          handlers.set(event, handler);
        },
      ),
    } as never);

    const ctx = { branch: 'ctx' };
    handlers.get('session_start')?.({}, ctx);
    expect(onSessionStart).toHaveBeenCalledWith(ctx);
    expect(lifecycle.generation).toBe(1);
  });
});
