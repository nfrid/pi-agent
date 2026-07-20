/** Shared isolation identifiers and manifest names used across broker modules. */
export const SAFE_ID = /^[0-9a-f-]{36}$/;

export const MANIFEST_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);
