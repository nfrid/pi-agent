import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { useModifierShortcut } from './modifier-shortcuts';

let dialogOpen = false;
const fakeWindow = new EventTarget();
const fakeDocument = Object.assign(new EventTarget(), {
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
});

function keyboard(
  type: string,
  values: Partial<KeyboardEvent> = {},
): KeyboardEvent {
  const event = new Event(type) as KeyboardEvent;
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(event, key, { value });
  return event;
}

function Probe({
  action,
  enabled = true,
}: {
  action: () => void;
  enabled?: boolean;
}) {
  const held = useModifierShortcut('n', action, enabled);
  return <span>{held ? 'held' : 'released'}</span>;
}

describe('modifier shortcuts', () => {
  afterEach(() => {
    dialogOpen = false;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  });

  function installDom() {
    (globalThis as { window?: unknown }).window = fakeWindow;
    (globalThis as { document?: unknown }).document = fakeDocument;
  }

  it('uses event.code, shows immediately, ignores composing/repeat, and resets on blur', () => {
    installDom();
    let calls = 0;
    const action = () => calls++;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<Probe action={action} />);
    });
    act(() => {
      fakeWindow.dispatchEvent(
        keyboard('keydown', {
          key: 'Meta',
          code: 'MetaLeft',
          repeat: false,
        }),
      );
    });
    expect(renderer.toJSON()).toEqual({
      type: 'span',
      props: {},
      children: ['held'],
    });

    act(() => {
      fakeWindow.dispatchEvent(
        keyboard('keydown', {
          key: 'Dead',
          code: 'KeyN',
          metaKey: true,
          altKey: true,
          repeat: false,
          isComposing: false,
        }),
      );
      fakeWindow.dispatchEvent(
        keyboard('keydown', {
          key: 'n',
          code: 'KeyN',
          metaKey: true,
          altKey: true,
          repeat: true,
          isComposing: false,
        }),
      );
      fakeWindow.dispatchEvent(
        keyboard('keydown', {
          key: 'n',
          code: 'KeyN',
          metaKey: true,
          altKey: true,
          repeat: false,
          isComposing: true,
        }),
      );
    });
    expect(calls).toBe(1);
    act(() => {
      fakeWindow.dispatchEvent(keyboard('blur'));
    });
    expect(renderer.toJSON()).toEqual({
      type: 'span',
      props: {},
      children: ['released'],
    });
    act(() => renderer.unmount());
  });

  it('keeps a stable registration through inline-action hint rerenders', () => {
    installDom();
    let calls = 0;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<Probe action={() => calls++} />);
    });
    act(() => {
      fakeWindow.dispatchEvent(
        keyboard('keydown', { key: 'Meta', code: 'MetaLeft' }),
      );
    });
    act(() => renderer.update(<Probe action={() => calls++} />));
    expect(renderer.toJSON()).toEqual({
      type: 'span',
      props: {},
      children: ['held'],
    });
    act(() => {
      fakeWindow.dispatchEvent(
        keyboard('keydown', {
          key: 'Dead',
          code: 'KeyN',
          metaKey: true,
          altKey: true,
        }),
      );
    });
    expect(calls).toBe(1);
    act(() => renderer.unmount());
  });

  it('selects one scoped owner and falls back when it unmounts', () => {
    installDom();
    let first = 0;
    let second = 0;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <>
          <Probe action={() => first++} />
          <Probe action={() => second++} />
        </>,
      );
    });
    act(() => {
      fakeWindow.dispatchEvent(
        keyboard('keydown', { key: 'Meta', code: 'MetaLeft' }),
      );
      fakeWindow.dispatchEvent(
        keyboard('keydown', {
          key: 'Dead',
          code: 'KeyN',
          metaKey: true,
          altKey: true,
        }),
      );
    });
    expect(first).toBe(0);
    expect(second).toBe(1);
    act(() => {
      fakeWindow.dispatchEvent(keyboard('keyup', { key: 'Meta' }));
    });
    act(() => renderer.update(<Probe action={() => first++} />));
    act(() => {
      fakeWindow.dispatchEvent(
        keyboard('keydown', { key: 'Meta', code: 'MetaLeft' }),
      );
      fakeWindow.dispatchEvent(
        keyboard('keydown', {
          key: 'Dead',
          code: 'KeyN',
          metaKey: true,
          altKey: true,
        }),
      );
    });
    expect(first).toBe(1);
    act(() => renderer.unmount());
  });

  it('suppresses actions while a dialog is open', () => {
    installDom();
    let calls = 0;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<Probe action={() => calls++} />);
    });
    dialogOpen = true;
    act(() => {
      fakeWindow.dispatchEvent(
        keyboard('keydown', { key: 'Meta', code: 'MetaLeft' }),
      );
      fakeWindow.dispatchEvent(
        keyboard('keydown', {
          key: 'Dead',
          code: 'KeyN',
          metaKey: true,
          altKey: true,
        }),
      );
    });
    expect(calls).toBe(0);
    act(() => renderer.unmount());
  });
});
