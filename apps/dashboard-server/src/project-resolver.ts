import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ProjectAssociationRepository } from './repositories/types.js';

export interface RuntimeAssociation {
  projectId: string | null;
  checkoutId: string | null;
}

const MAX_RESOLVED_CWD_CACHE = 4096;

function canonical(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(canonical(root), canonical(target));
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/**
 * Resolve runtime cwd ownership without consulting Sesh. The resolver is
 * deliberately synchronous because registry callbacks are synchronous; Git
 * identity lookups are bounded and cached by canonical cwd.
 */
export class ProjectResolver {
  private readonly gitIdentityByCwd = new Map<string, string | null>();

  constructor(private readonly repository: ProjectAssociationRepository) {}

  resolve(cwd: string): RuntimeAssociation {
    const target = canonical(cwd);
    const checkouts = this.repository
      .listCheckouts()
      .filter((checkout) => checkout.status !== 'retired')
      .map((checkout) => ({ checkout, root: canonical(checkout.path) }))
      .filter(({ root }) => contains(root, target))
      .sort((left, right) => right.root.length - left.root.length);
    const nearest = checkouts[0];
    if (nearest)
      return {
        projectId: nearest.checkout.projectId,
        checkoutId: nearest.checkout.id,
      };

    const identity = this.gitIdentity(target);
    if (identity) {
      const project = this.repository.getProjectByRepositoryIdentity(identity);
      if (project)
        return {
          projectId: project.id,
          checkoutId: null,
        };
    }

    const nonGitProjects = this.repository
      .listProjects()
      .filter((project) => project.repositoryIdentity === undefined)
      .filter((project) => contains(project.rootPath, target))
      .sort(
        (left, right) =>
          canonical(right.rootPath).length - canonical(left.rootPath).length,
      );
    const project = nonGitProjects[0];
    return project
      ? { projectId: project.id, checkoutId: null }
      : { projectId: null, checkoutId: null };
  }

  /** Registry-friendly spelling retained beside the test-facing resolver. */
  resolveRuntime(cwd: string): RuntimeAssociation {
    return this.resolve(cwd);
  }

  private gitIdentity(cwd: string): string | undefined {
    const key = canonical(cwd);
    if (this.gitIdentityByCwd.has(key)) {
      const value = this.gitIdentityByCwd.get(key);
      return value ?? undefined;
    }
    if (!existsSync(key)) {
      this.rememberGitIdentity(key, null);
      return undefined;
    }
    try {
      const raw = execFileSync(
        'git',
        ['-C', key, 'rev-parse', '--git-common-dir'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      const root = execFileSync(
        'git',
        ['-C', key, 'rev-parse', '--show-toplevel'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      const identity = canonical(
        path.isAbsolute(raw) ? raw : path.resolve(root, raw),
      );
      this.rememberGitIdentity(key, identity);
      return identity;
    } catch {
      this.rememberGitIdentity(key, null);
      return undefined;
    }
  }

  private rememberGitIdentity(cwd: string, identity: string | null): void {
    this.gitIdentityByCwd.delete(cwd);
    this.gitIdentityByCwd.set(cwd, identity);
    if (this.gitIdentityByCwd.size <= MAX_RESOLVED_CWD_CACHE) return;
    const oldest = this.gitIdentityByCwd.keys().next().value;
    if (oldest !== undefined) this.gitIdentityByCwd.delete(oldest);
  }
}
