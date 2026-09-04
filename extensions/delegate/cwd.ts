import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

export const MAX_DELEGATE_SKILLS = 16;
const MAX_DELEGATE_SKILL_PATH_LENGTH = 4096;

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

/** Resolve and validate explicit skill files/directories before isolation. */
export function resolveDelegateSkills(
  requested: string[] | undefined,
  cwd: string,
): string[] {
  if (requested === undefined) return [];
  if (!Array.isArray(requested) || requested.length > MAX_DELEGATE_SKILLS)
    throw new Error(
      `Delegate skills must contain at most ${MAX_DELEGATE_SKILLS} paths.`,
    );
  return requested.map((entry) => {
    if (
      typeof entry !== 'string' ||
      !entry.trim() ||
      entry.length > MAX_DELEGATE_SKILL_PATH_LENGTH
    )
      throw new Error(
        'Delegate skill paths must be non-empty strings of at most 4096 characters.',
      );
    const resolved = resolveDelegateCwd(entry, cwd);
    if (!existsSync(resolved))
      throw new Error(`Delegate skill path does not exist: ${resolved}`);
    return resolved;
  });
}

/** Validate persisted skill paths without resolving them against a new cwd. */
export function validDelegateSkills(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_DELEGATE_SKILLS &&
    value.every(
      (entry) =>
        typeof entry === 'string' &&
        path.isAbsolute(entry) &&
        entry.trim() === entry &&
        entry.length > 0 &&
        entry.length <= MAX_DELEGATE_SKILL_PATH_LENGTH,
    )
  );
}
