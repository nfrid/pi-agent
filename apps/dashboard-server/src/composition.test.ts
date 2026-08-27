import { describe, expect, it } from 'vitest';
import { sessionUsageDirectories } from './composition.js';

describe('session usage directories', () => {
  it('keeps a custom delegate archive beside its custom active directory', () => {
    expect(
      sessionUsageDirectories({
        sessionDir: '/workspace/sessions',
        delegateSessionDir: '/separate/delegates',
      }),
    ).toEqual([
      '/workspace/sessions',
      '/separate/delegates',
      '/workspace/session-archive/sessions',
      '/separate/session-archive/delegates',
    ]);
  });
});
