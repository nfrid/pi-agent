import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { createManagedWidget } from './widget';

type WidgetFactory = (
  tui: { requestRender: () => void },
  theme: unknown,
) => {
  dispose?: () => void;
  invalidate: () => void;
  render: (width: number) => string[];
};

function fakeUI() {
  const setWidget = vi.fn();
  return {
    setWidget,
    ui: { setWidget } as unknown as ExtensionUIContext,
    factories: () =>
      setWidget.mock.calls.filter(
        (call) => typeof call[1] === 'function',
      ) as unknown as [string, WidgetFactory][],
    unmounts: () =>
      setWidget.mock.calls.filter((call) => call[1] === undefined),
  };
}

const theme = { fg: (_color: string, text: string) => text };

describe('createManagedWidget', () => {
  it('does not mount while inactive', () => {
    const host = fakeUI();
    const widget = createManagedWidget({
      key: 'w',
      isActive: () => false,
      render: () => ['body'],
    });
    widget.attach(host.ui);
    expect(host.factories()).toHaveLength(0);
  });

  it('mounts once active and renders through the factory', () => {
    const host = fakeUI();
    const widget = createManagedWidget({
      key: 'w',
      isActive: () => true,
      render: (width) => [`body ${width}`],
    });
    widget.attach(host.ui);

    const [[key, factory]] = host.factories();
    expect(key).toBe('w');
    expect(factory({ requestRender: vi.fn() }, theme).render(42)).toEqual([
      'body 42',
    ]);
  });

  it('keeps one mounted component across plain syncs', () => {
    const host = fakeUI();
    const widget = createManagedWidget({
      key: 'w',
      isActive: () => true,
      render: () => ['body'],
    });
    widget.attach(host.ui);
    widget.sync();
    widget.sync();
    expect(host.factories()).toHaveLength(1);
  });

  it('remounts on reassert, for hosts that drop keyed widgets', () => {
    const host = fakeUI();
    const widget = createManagedWidget({
      key: 'w',
      isActive: () => true,
      render: () => ['body'],
    });
    widget.attach(host.ui);
    widget.reassert();
    expect(host.factories()).toHaveLength(2);
  });

  it('coalesces burst render requests onto one frame', async () => {
    const host = fakeUI();
    const widget = createManagedWidget({
      key: 'w',
      isActive: () => true,
      render: () => ['body'],
    });
    widget.attach(host.ui);

    const requestRender = vi.fn();
    host.factories()[0][1]({ requestRender }, theme);
    widget.sync();
    widget.sync();
    widget.sync();

    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it('unmounts when the widget becomes inactive', () => {
    const host = fakeUI();
    let active = true;
    const widget = createManagedWidget({
      key: 'w',
      isActive: () => active,
      render: () => ['body'],
    });
    widget.attach(host.ui);
    active = false;
    widget.sync();
    expect(host.unmounts()).toHaveLength(1);
  });

  it('does not repeatedly unmount an already-unmounted widget', () => {
    const host = fakeUI();
    const widget = createManagedWidget({
      key: 'w',
      isActive: () => false,
      render: () => ['body'],
    });
    widget.attach(host.ui);
    widget.sync();
    widget.sync();
    expect(host.unmounts()).toHaveLength(0);
  });

  it('unmounts and releases the UI on detach', () => {
    const host = fakeUI();
    const widget = createManagedWidget({
      key: 'w',
      isActive: () => true,
      render: () => ['body'],
    });
    widget.attach(host.ui);
    widget.detach();
    expect(host.unmounts()).toHaveLength(1);

    // Further activity must not reach the released UI.
    host.setWidget.mockClear();
    widget.sync();
    widget.reassert();
    expect(host.setWidget).not.toHaveBeenCalled();
  });

  it('is inert without a UI, for headless sessions', () => {
    const widget = createManagedWidget({
      key: 'w',
      isActive: () => true,
      render: () => ['body'],
    });
    expect(() => {
      widget.attach(undefined);
      widget.sync();
      widget.reassert();
      widget.detach();
    }).not.toThrow();
  });

  it('reports a setWidget failure once rather than swallowing it', () => {
    const onError = vi.fn();
    const failure = new Error('ui gone');
    const setWidget = vi.fn(() => {
      throw failure;
    });
    const widget = createManagedWidget({
      key: 'w',
      isActive: () => true,
      render: () => ['body'],
      onError,
    });

    widget.attach({ setWidget } as unknown as ExtensionUIContext);
    widget.reassert();
    widget.reassert();

    expect(setWidget).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('stops its refresh timer once detached', () => {
    vi.useFakeTimers();
    try {
      const host = fakeUI();
      const widget = createManagedWidget({
        key: 'w',
        isActive: () => true,
        render: () => ['body'],
        refreshMs: 1_000,
      });
      widget.attach(host.ui);
      const requestRender = vi.fn();
      host.factories()[0][1]({ requestRender }, theme);

      vi.advanceTimersByTime(5_000);
      expect(requestRender).toHaveBeenCalled();

      widget.detach();
      requestRender.mockClear();
      vi.advanceTimersByTime(5_000);
      expect(requestRender).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
