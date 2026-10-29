import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThreadShortcuts } from './shortcuts';

type Options = Parameters<typeof useThreadShortcuts>[0];
let controls: ReturnType<typeof useThreadShortcuts>;
let renderer: ReactTestRenderer | undefined;
let windowEvents: EventTarget;
let documentEvents: EventTarget;
let dialogOpen: boolean;

// Node's EventTarget does not remove capture listeners with a boolean option.
// Normalize that option so this fixture follows the browser contract.
class BrowserEvents extends EventTarget {
  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    super.addEventListener(
      type,
      callback,
      typeof options === 'boolean' ? { capture: options } : options,
    );
  }
  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    super.removeEventListener(
      type,
      callback,
      typeof options === 'boolean' ? { capture: options } : options,
    );
  }
}

function Harness(options: Options) {
  controls = useThreadShortcuts(options);
  return null;
}
async function render(options: Options) {
  await act(async () => {
    if (renderer) renderer.update(createElement(Harness, options));
    else renderer = create(createElement(Harness, options));
  });
}
async function key(
  value: string,
  options: Partial<KeyboardEvent> = {},
  type = 'keydown',
) {
  const event = Object.assign(new Event(type, { cancelable: true }), {
    key: value,
    code: value === 'Meta' ? 'MetaLeft' : value,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...options,
  });
  await act(async () => {
    windowEvents.dispatchEvent(event);
  });
  return event;
}
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  windowEvents = new BrowserEvents();
  documentEvents = new BrowserEvents();
  dialogOpen = false;
  vi.stubGlobal(
    'window',
    Object.assign(windowEvents, { setTimeout, clearTimeout }),
  );
  vi.stubGlobal(
    'document',
    Object.assign(documentEvents, {
      querySelectorAll: () =>
        dialogOpen
          ? [
              {
                hidden: false,
                getAttribute: () => null,
                getClientRects: () => [{}],
              },
            ]
          : [],
    }),
  );
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('thread shortcut gestures', () => {
  it('keeps the gesture target snapshot while using the current navigation callback', async () => {
    const first = vi.fn();
    const latest = vi.fn();
    await render({
      getTargets: () => ['one', 'two'],
      select: first,
      blocked: false,
    });
    await key('Meta');
    await key('a', {}, 'keyup');
    expect(controls.shortcutHintsVisible).toBe(false);
    await advance(80);
    expect(controls.shortcutHintsVisible).toBe(true);
    await render({
      getTargets: () => ['other'],
      select: latest,
      blocked: false,
    });
    expect((await key('2')).defaultPrevented).toBe(true);
    expect(latest).toHaveBeenCalledWith('two');
    expect(first).not.toHaveBeenCalled();
    await key('Meta', {}, 'keyup');
    expect(controls.shortcutHintsVisible).toBe(false);
    await advance(140);
    expect(controls.shortcutTargetIds).toEqual([]);
    await key('Meta');
    await key('1');
    expect(latest).toHaveBeenLastCalledWith('other');
  });

  it('cancels a held gesture when blocked and requires a new gesture after unblocking', async () => {
    const select = vi.fn();
    const options = { getTargets: () => ['one'], select, blocked: false };
    await render(options);
    await key('Meta');
    await advance(80);
    await render({ ...options, blocked: true });
    expect(controls.shortcutHintsVisible).toBe(false);
    await key('1');
    await key('Meta');
    await advance(140);
    expect(controls.shortcutTargetIds).toEqual([]);
    await render(options);
    await key('1');
    expect(select).not.toHaveBeenCalled();
    await key('Meta');
    await key('1');
    expect(select).toHaveBeenCalledWith('one');
  });

  it('does not navigate through an open dialog or modified digit bindings', async () => {
    const select = vi.fn();
    await render({ getTargets: () => ['one'], select, blocked: false });
    dialogOpen = true;
    await key('Meta');
    await key('1');
    expect(select).not.toHaveBeenCalled();
    dialogOpen = false;
    await key('Meta');
    await key('Meta', { repeat: true });
    for (const modifiers of [
      { ctrlKey: true },
      { altKey: true },
      { shiftKey: true },
      { metaKey: false },
    ])
      await key('1', modifiers);
    for (const value of ['0', '10', '1.5', 'x']) await key(value);
    dialogOpen = true;
    await key('1');
    expect(select).not.toHaveBeenCalled();
  });

  it('clears the gesture on blur and visibility changes and tolerates an empty target list', async () => {
    const options = {
      getTargets: () => ['one'],
      select: vi.fn(),
      blocked: false,
    };
    await render(options);
    await key('Meta');
    await advance(80);
    await act(async () => {
      windowEvents.dispatchEvent(new Event('blur'));
    });
    expect(controls.shortcutHintsVisible).toBe(false);
    await key('Meta');
    await act(async () => {
      documentEvents.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(140);
    expect(controls.shortcutTargetIds).toEqual([]);
    await render({ ...options, getTargets: () => [] });
    await key('Meta');
    await advance(80);
    expect(controls.shortcutHintsVisible).toBe(false);
  });

  it.each([
    'MetaLeft',
    'MetaRight',
  ])('recognizes the %s code when key is unidentified', async (code) => {
    const select = vi.fn();
    await render({ getTargets: () => ['one'], select, blocked: false });
    await key('Unidentified', { code });
    await key('1');
    expect(select).toHaveBeenCalledWith('one');
    await key('Unidentified', { code }, 'keyup');
    await key('1');
    expect(select).toHaveBeenCalledTimes(1);
  });

  it.each([
    'reveal',
    'exit',
  ])('cancels the %s timer and navigation listeners on unmount', async (phase) => {
    const select = vi.fn();
    await render({ getTargets: () => ['one'], select, blocked: false });
    await key('Meta');
    if (phase === 'exit') await key('Meta', {}, 'keyup');
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    await key('Meta');
    await key('1');
    await advance(200);
    expect(select).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
