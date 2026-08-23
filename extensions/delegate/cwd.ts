import { homedir } from 'node:os';
import * as path from 'node:path';

/** Resolve fresh model input relative to the invoking Pi session. */
export function resolveDelegateCwd(
  requested: string | undefined,
  parentCwd: string,
): string {
  const base = path.resolve(parentCwd);
  if (requested === undefined) return base;
  const value = requested.trim();
  if (value === '~') return path.resolve(process.env.HOME?.trim() || homedir());
  if (value.startsWith('~/')) {
    return path.resolve(process.env.HOME?.trim() || homedir(), value.slice(2));
  }
  return path.resolve(base, value);
}
