import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const META_ROOT_MARKER = join('.agents', 'meta-root');

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findNearestGitRoot(cwd: string): string | undefined {
  let cursor = realpathSync(resolve(cwd));
  while (true) {
    if (existsSync(join(cursor, '.git'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

/**
 * Find a user-owned meta-repository above the current Git trust boundary.
 *
 * Mark the outer root with `.agents/meta-root`; its `.agents/skills` directory
 * is then shared with nested repositories. Markers inside the nearest Git root
 * are deliberately ignored because project-local skills belong to Pi's normal
 * trusted discovery.
 */
export function findOuterMetaSkillPath(cwd: string): string | undefined {
  const gitRoot = findNearestGitRoot(cwd);
  if (!gitRoot) return;

  let cursor = dirname(gitRoot);
  while (true) {
    if (fileExists(join(cursor, META_ROOT_MARKER))) {
      const skills = join(cursor, '.agents', 'skills');
      return directoryExists(skills) ? realpathSync(skills) : undefined;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
