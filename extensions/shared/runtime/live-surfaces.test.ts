import { describe, expect, it } from 'vitest';
import {
  getLiveExtensionSurfaceHub,
  LiveSurfaceHub,
  liveExtensionSurfaceHub,
  MAX_LIVE_EXTENSION_SURFACES_PER_EXTENSION,
} from './live-surfaces';

describe('live surface hub', () => {
  it('uses a process-global singleton across isolated extension modules', () => {
    expect(getLiveExtensionSurfaceHub()).toBe(liveExtensionSurfaceHub);
    expect(
      Reflect.get(
        globalThis,
        Symbol.for('pi.dashboard.live-extension-surfaces'),
      ),
    ).toBe(liveExtensionSurfaceHub);
  });

  it('publishes bounded source slots and removes them on clear', () => {
    const hub = new LiveSurfaceHub();
    const updates: unknown[][] = [];
    hub.subscribe((surfaces) => updates.push([...surfaces]));
    const surfaces = Array.from(
      { length: MAX_LIVE_EXTENSION_SURFACES_PER_EXTENSION + 1 },
      (_, index) => ({
        id: `surface-${index}`,
        rendererId: 'test.renderer',
        viewModel: { index },
      }),
    );

    hub.publish('test', surfaces);

    expect(hub.snapshot()).toHaveLength(
      MAX_LIVE_EXTENSION_SURFACES_PER_EXTENSION,
    );
    expect(updates).toHaveLength(1);
    hub.clear('test');
    expect(hub.snapshot()).toEqual([]);
    expect(updates).toHaveLength(2);
  });

  it('rejects duplicate surface IDs across extension sources atomically', () => {
    const hub = new LiveSurfaceHub();
    const surface = {
      id: 'shared.surface',
      rendererId: 'test.renderer',
      viewModel: {},
    };
    hub.publish('first', [surface]);
    expect(() => hub.publish('second', [surface])).toThrow(
      'Duplicate extension surface ID',
    );
    expect(hub.snapshot()).toEqual([surface]);
  });

  it('isolates source replacement and unsubscribe lifecycle', () => {
    const hub = new LiveSurfaceHub();
    const listener = () => {
      throw new Error('unsubscribed listener called');
    };
    const unsubscribe = hub.subscribe(listener);
    unsubscribe();
    hub.publish('delegate', [
      { id: 'delegate.status', rendererId: 'delegate.status', viewModel: {} },
    ]);
    hub.publish('tasks', [
      { id: 'tasks.current', rendererId: 'tasks.current', viewModel: {} },
    ]);
    expect(hub.snapshot().map((surface) => surface.id)).toEqual([
      'delegate.status',
      'tasks.current',
    ]);
    hub.publish('delegate', [
      {
        id: 'delegate.status',
        rendererId: 'delegate.status',
        viewModel: { changed: true },
      },
    ]);
    expect(hub.snapshot().map((surface) => surface.viewModel)).toEqual([
      { changed: true },
      {},
    ]);
  });
});
