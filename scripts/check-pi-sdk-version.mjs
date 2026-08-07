#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PI_SDK_PACKAGES = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
];

// Pi 0.84.x imports this exact TypeBox release. Keep it in the same check as
// the SDK packages so a later SDK sync cannot silently reintroduce a drift.
export const PI_SDK_TYPEBOX_VERSION = '1.3.7';

export function sdkVersionMismatches(manifest, runtimeVersion) {
  const sdkMismatches = PI_SDK_PACKAGES.flatMap((packageName) => {
    const declaredVersion = manifest.dependencies?.[packageName];
    return declaredVersion === runtimeVersion
      ? []
      : [{ packageName, declaredVersion }];
  });
  const declaredTypeboxVersion = manifest.dependencies?.typebox;
  return declaredTypeboxVersion === PI_SDK_TYPEBOX_VERSION
    ? sdkMismatches
    : [
        ...sdkMismatches,
        { packageName: 'typebox', declaredVersion: declaredTypeboxVersion },
      ];
}

export function checkPiSdkVersions({
  manifest,
  runtimeVersion,
  logError = console.error,
}) {
  const mismatches = sdkVersionMismatches(manifest, runtimeVersion);
  if (mismatches.length === 0) return true;

  logError(`Pi SDK versions must match the Pi runtime (${runtimeVersion}).`);
  for (const { packageName, declaredVersion } of mismatches) {
    logError(`- ${packageName}: ${declaredVersion ?? 'missing'}`);
  }
  logError('Fix: pnpm run pi:sdk-sync');
  return false;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifestUrl = new URL('../package.json', import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  let runtimeVersion;

  try {
    runtimeVersion = execFileSync('pi', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    console.error(`Unable to read the Pi runtime version: ${error.message}`);
    process.exit(1);
  }

  if (!checkPiSdkVersions({ manifest, runtimeVersion })) process.exit(1);
}
