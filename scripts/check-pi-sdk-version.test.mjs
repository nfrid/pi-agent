import { describe, expect, it, vi } from 'vitest';
import {
  checkPiSdkVersions,
  PI_SDK_PACKAGES,
  sdkVersionMismatches,
} from './check-pi-sdk-version.mjs';

function manifestWithVersions(version) {
  return {
    dependencies: Object.fromEntries(
      PI_SDK_PACKAGES.map((packageName) => [packageName, version]),
    ),
  };
}

describe('Pi SDK version validation', () => {
  it('accepts exact matches with the runtime', () => {
    const manifest = manifestWithVersions('0.82.1');

    expect(sdkVersionMismatches(manifest, '0.82.1')).toEqual([]);
    expect(checkPiSdkVersions({ manifest, runtimeVersion: '0.82.1' })).toBe(
      true,
    );
  });

  it('reports mismatched and missing SDK dependencies', () => {
    const manifest = manifestWithVersions('0.81.0');
    delete manifest.dependencies['@earendil-works/pi-tui'];
    const logError = vi.fn();

    expect(
      checkPiSdkVersions({
        manifest,
        runtimeVersion: '0.82.1',
        logError,
      }),
    ).toBe(false);
    expect(logError.mock.calls.flat()).toEqual([
      'Pi SDK versions must match the Pi runtime (0.82.1).',
      '- @earendil-works/pi-ai: 0.81.0',
      '- @earendil-works/pi-coding-agent: 0.81.0',
      '- @earendil-works/pi-tui: missing',
      'Fix: pnpm run pi:sdk-sync',
    ]);
  });

  it('rejects non-exact dependency ranges', () => {
    const manifest = manifestWithVersions('^0.82.1');

    expect(sdkVersionMismatches(manifest, '0.82.1')).toHaveLength(3);
  });
});
