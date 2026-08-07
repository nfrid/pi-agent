import { describe, expect, it, vi } from 'vitest';
import {
  checkPiSdkVersions,
  PI_SDK_PACKAGES,
  PI_SDK_TYPEBOX_VERSION,
  sdkVersionMismatches,
} from './check-pi-sdk-version.mjs';

function manifestWithVersions(
  version,
  typeboxVersion = PI_SDK_TYPEBOX_VERSION,
) {
  return {
    dependencies: {
      ...Object.fromEntries(
        PI_SDK_PACKAGES.map((packageName) => [packageName, version]),
      ),
      typebox: typeboxVersion,
    },
  };
}

describe('Pi SDK version validation', () => {
  it('accepts exact matches with the runtime', () => {
    const manifest = manifestWithVersions('0.84.1');

    expect(sdkVersionMismatches(manifest, '0.84.1')).toEqual([]);
    expect(checkPiSdkVersions({ manifest, runtimeVersion: '0.84.1' })).toBe(
      true,
    );
  });

  it('reports mismatched and missing SDK dependencies', () => {
    const manifest = manifestWithVersions('0.83.0', '1.1.38');
    delete manifest.dependencies['@earendil-works/pi-tui'];
    const logError = vi.fn();

    expect(
      checkPiSdkVersions({
        manifest,
        runtimeVersion: '0.84.1',
        logError,
      }),
    ).toBe(false);
    expect(logError.mock.calls.flat()).toEqual([
      'Pi SDK versions must match the Pi runtime (0.84.1).',
      '- @earendil-works/pi-ai: 0.83.0',
      '- @earendil-works/pi-coding-agent: 0.83.0',
      '- @earendil-works/pi-tui: missing',
      '- typebox: 1.1.38',
      'Fix: pnpm run pi:sdk-sync',
    ]);
  });

  it('rejects non-exact dependency ranges', () => {
    const manifest = manifestWithVersions('^0.84.1');

    expect(sdkVersionMismatches(manifest, '0.84.1')).toHaveLength(3);
  });

  it('rejects a TypeBox version outside the Pi-compatible exact release', () => {
    const manifest = manifestWithVersions('0.84.1', '1.1.38');

    expect(sdkVersionMismatches(manifest, '0.84.1')).toEqual([
      { packageName: 'typebox', declaredVersion: '1.1.38' },
    ]);
  });
});
