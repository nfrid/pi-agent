import { describe, expect, it } from 'vitest';
import { getLiveExtensionSurfaceHub } from '../shared/runtime/live-surfaces';
import { SETTLED_BACKGROUND_RENDERER_ID } from './contribution';
import { clearSettledBackground, publishSettledBackground } from './live';

describe('settled background live surface', () => {
  it('publishes, updates, and clears the active count', () => {
    const scope = `settled-background-${Date.now()}`;
    const hub = getLiveExtensionSurfaceHub(scope);
    publishSettledBackground(1, scope);
    expect(hub.snapshot()).toEqual([
      expect.objectContaining({
        rendererId: SETTLED_BACKGROUND_RENDERER_ID,
        viewModel: { version: 1, count: 1 },
      }),
    ]);
    publishSettledBackground(3, scope);
    expect(hub.snapshot()[0]?.viewModel).toEqual({ version: 1, count: 3 });
    clearSettledBackground(scope);
    expect(hub.snapshot()).toEqual([]);
  });
});
