import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import * as path from 'node:path';

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export function canonicalPath(cwd: string, target: string): string {
  if (!target || target.includes('\0')) throw new Error('invalid target path');
  const requested = path.resolve(cwd, target);
  let ancestor = requested;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('target has no existing ancestor');
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(realpathSync(ancestor), ...missing);
}

function directoryFor(target: string): string {
  if (!existsSync(target)) return path.dirname(target);
  return lstatSync(target).isDirectory() ? target : path.dirname(target);
}

export function repositoryRootForPath(target: string): string {
  const canonical = canonicalPath(process.cwd(), target);
  const directory = directoryFor(canonical);
  try {
    return realpathSync(
      execFileSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    return realpathSync(directory);
  }
}

function configuredRepositoryPaths(root: string): string[] {
  const candidates = [
    path.join(root, 'mg', 'mg.config.json'),
    path.join(root, 'mg.config.json'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const config = JSON.parse(readFileSync(candidate, 'utf8')) as {
        repos?: Array<{ path?: unknown }>;
      };
      return (config.repos ?? [])
        .map((entry) =>
          typeof entry.path === 'string' ? entry.path.trim() : '',
        )
        .filter(Boolean);
    } catch {
      return [];
    }
  }
  return [];
}

export interface NestedRepositoryScan {
  roots: string[];
  complete: boolean;
}

export function scanNestedRepositories(
  root: string,
  maxDirectories = 50_000,
): NestedRepositoryScan {
  if (!existsSync(root)) return { roots: [], complete: false };
  const canonicalRoot = realpathSync(root);
  const roots = new Set(
    configuredRepositoryPaths(canonicalRoot)
      .filter((candidate) => existsSync(candidate))
      .map((candidate) => repositoryRootForPath(candidate))
      .filter(
        (repository) =>
          repository !== canonicalRoot && isInside(canonicalRoot, repository),
      ),
  );
  const queue = [canonicalRoot];
  let visited = 0;
  let complete = true;
  while (queue.length > 0) {
    const directory = queue.shift() as string;
    if (++visited > maxDirectories) {
      complete = false;
      break;
    }
    let entries: Array<{
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
      name: string;
    }>;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      complete = false;
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const candidate = path.join(directory, entry.name);
      if (existsSync(path.join(candidate, '.git'))) {
        roots.add(repositoryRootForPath(candidate));
        continue;
      }
      queue.push(candidate);
    }
  }
  return { roots: [...roots].sort(), complete };
}

export function nestedRepositoryRoots(root: string): string[] {
  return scanNestedRepositories(root).roots;
}

export function discoverTrustedRepositoryRoots(rawRoots: string[]): string[] {
  const roots = new Set<string>();
  for (const raw of rawRoots) {
    if (!raw || !existsSync(raw)) continue;
    const trusted = realpathSync(raw);
    roots.add(repositoryRootForPath(trusted));
    for (const repository of nestedRepositoryRoots(trusted))
      roots.add(repository);
  }
  return [...roots].sort();
}

export function isTrustedRepository(
  repositoryRoot: string,
  trustedRoots: string[],
): boolean {
  if (!existsSync(repositoryRoot)) return false;
  const repository = realpathSync(repositoryRoot);
  return trustedRoots.some((root) => {
    if (!existsSync(root)) return false;
    const canonical = realpathSync(root);
    return isInside(canonical, repository);
  });
}
