#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PI_SDK_PACKAGES = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
];

export function sdkVersionMismatches(manifest, runtimeVersion) {
  return PI_SDK_PACKAGES.flatMap((packageName) => {
    const declaredVersion = manifest.dependencies?.[packageName];
    return declaredVersion === runtimeVersion
      ? []
      : [{ packageName, declaredVersion }];
  });
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
