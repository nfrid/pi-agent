import { describe, expect, it, vi } from 'vitest';
import {
  abortableDelay,
  abortError,
  throwIfAborted,
  waitFor,
  withAbort,
} from './async';

function abortedWith(reason?: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

describe('abortError', () => {
  it('preserves a caller-supplied Error reason', () => {
    const reason = new Error('cancelled by user');
    expect(abortError(abortedWith(reason))).toBe(reason);
  });

  it("adopts the runtime's own AbortError when abort() is given no reason", () => {
    // Node populates signal.reason with a DOMException, and DOMException
    // extends Error — so that reason is authoritative and passes straight
    // through rather than being substituted.
    const error = abortError(abortedWith());
    expect(error).toBeInstanceOf(DOMException);
    expect(error.name).toBe('AbortError');
  });

  it('substitutes a DOMException for a non-Error reason', () => {
    const error = abortError(abortedWith('string reason'));
    expect(error).toBeInstanceOf(DOMException);
    expect(error.name).toBe('AbortError');
  });

  it('substitutes the caller message for a non-Error reason when given one', () => {
    const error = abortError(abortedWith('string reason'), 'Codex aborted.');
    expect(error).not.toBeInstanceOf(DOMException);
    expect(error.message).toBe('Codex aborted.');
  });

  it('still prefers a real reason over the fallback message', () => {
    const reason = new Error('real cause');
    expect(abortError(abortedWith(reason), 'fallback')).toBe(reason);
  });
});

describe('throwIfAborted', () => {
  it('does nothing without a signal', () => {
    expect(() => throwIfAborted()).not.toThrow();
  });

  it('does nothing for a live signal', () => {
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  it('throws the abort reason once aborted', () => {
    const reason = new Error('stop');
    expect(() => throwIfAborted(abortedWith(reason))).toThrow(reason);
  });
});

describe('waitFor', () => {
  it('resolves early when the timeout elapses first', async () => {
    let settle = () => {};
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    await expect(waitFor(pending, 5)).resolves.toBeUndefined();
    settle();
  });

  it('resolves as soon as the promise settles', async () => {
    await expect(waitFor(Promise.resolve(), 10_000)).resolves.toBeUndefined();
  });

  it('resolves immediately for a non-positive timeout', async () => {
    await expect(
      waitFor(new Promise<void>(() => {}), 0),
    ).resolves.toBeUndefined();
  });

  it('rejects when the signal is already aborted', async () => {
    await expect(
      waitFor(Promise.resolve(), 10, abortedWith()),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects when the signal aborts while waiting', async () => {
    const controller = new AbortController();
    const pending = waitFor(
      new Promise<void>(() => {}),
      10_000,
      controller.signal,
    );
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
  });

  it('propagates a rejection from the awaited promise', async () => {
    const failure = new Error('inner failure');
    await expect(waitFor(Promise.reject(failure), 10_000)).rejects.toBe(
      failure,
    );
  });

  it('removes its abort listener once settled', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await waitFor(Promise.resolve(), 10_000, controller.signal);
    expect(remove).toHaveBeenCalled();
  });
});

describe('withAbort', () => {
  it('resolves with the underlying value', async () => {
    await expect(
      withAbort(Promise.resolve('value'), new AbortController().signal),
    ).resolves.toBe('value');
  });

  it('rejects as soon as the signal aborts, without waiting', async () => {
    const controller = new AbortController();
    const pending = withAbort(new Promise(() => {}), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects immediately for an already-aborted signal', async () => {
    await expect(
      withAbort(Promise.resolve('ignored'), abortedWith(new Error('gone'))),
    ).rejects.toThrow('gone');
  });

  it('propagates the underlying rejection unchanged', async () => {
    const failure = new Error('inner');
    await expect(
      withAbort(Promise.reject(failure), new AbortController().signal),
    ).rejects.toBe(failure);
  });
});

describe('abortableDelay', () => {
  it('resolves after the delay', async () => {
    await expect(abortableDelay(1)).resolves.toBeUndefined();
  });

  it('rejects when aborted mid-delay', async () => {
    const controller = new AbortController();
    const pending = abortableDelay(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects without waiting when already aborted', async () => {
    await expect(
      abortableDelay(10_000, abortedWith(new Error('nope'))),
    ).rejects.toThrow('nope');
  });
});
