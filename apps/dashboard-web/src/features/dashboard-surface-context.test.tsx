import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  type DashboardSurfaceContextValue,
  DashboardSurfaceProvider,
  useDashboardSurfaces,
} from './dashboard-surface-context';

describe('dashboard surface context', () => {
  it('does not publish state updates when the surface stack is already clear', () => {
    let surfaces: DashboardSurfaceContextValue | undefined;
    let renders = 0;
    function Probe() {
      surfaces = useDashboardSurfaces();
      renders += 1;
      return null;
    }

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <DashboardSurfaceProvider locationKey="/">
          <Probe />
        </DashboardSurfaceProvider>,
      );
    });
    const initialRenders = renders;

    act(() => surfaces?.close());
    expect(renders).toBe(initialRenders);

    act(() => surfaces?.open({ type: 'settings' }));
    expect(surfaces?.stack).toEqual([{ type: 'settings' }]);
    act(() => surfaces?.open({ type: 'usage-analytics' }));
    expect(surfaces?.stack).toEqual([
      { type: 'settings' },
      { type: 'usage-analytics' },
    ]);
    act(() => surfaces?.replace({ type: 'command-palette' }));
    expect(surfaces?.stack).toEqual([{ type: 'command-palette' }]);
    act(() => surfaces?.replace({ type: 'new-thread-project' }));
    expect(surfaces?.stack).toEqual([{ type: 'new-thread-project' }]);
    act(() => surfaces?.close());
    expect(surfaces?.stack).toEqual([]);
    const clearedRenders = renders;

    act(() => surfaces?.close());
    expect(renders).toBe(clearedRenders);
    renderer.unmount();
  });
});
