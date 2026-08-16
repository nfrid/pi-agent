import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

export interface GitOptions {
  input?: Buffer;
  encoding?: BufferEncoding | 'buffer';
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export function canonical(value: string): string {
  return realpathSync(value);
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export async function git(
  cwd: string,
  args: string[],
  options: GitOptions = {},
): Promise<string | Buffer> {
  const encoding = options.encoding ?? 'utf8';
  const child = execFileAsync('git', ['-C', cwd, ...args], {
    encoding: encoding === 'buffer' ? 'buffer' : encoding,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    maxBuffer: MAX_GIT_OUTPUT,
    signal: options.signal,
  });
  if (options.input !== undefined) {
    child.child.stdin?.end(options.input);
  }
  const result = await child;
  return result.stdout;
}

export async function gitText(
  cwd: string,
  args: string[],
  options: GitOptions = {},
): Promise<string> {
  return String(await git(cwd, args, options)).trim();
}

/** Resolve the repository root containing `cwd`. */
export async function repositoryRoot(
  cwd: string,
  options: GitOptions = {},
): Promise<string> {
  const root = canonical(
    await gitText(cwd, ['rev-parse', '--show-toplevel'], options),
  );
  if (!isInside(root, canonical(cwd)))
    throw new Error('cwd is outside the repository root');
  return root;
}

/**
 * Stable identity for a repository and all of its linked worktrees. Git's
 * common directory, rather than the discovered checkout path, is the durable
 * project key used by dashboard adoption.
 */
export async function repositoryIdentity(
  cwd: string,
  options: GitOptions = {},
): Promise<string> {
  const raw = await gitText(cwd, ['rev-parse', '--git-common-dir'], options);
  const root = await repositoryRoot(cwd, options);
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  return canonical(resolved);
}

/**
 * Split a NUL-delimited git output list.
 *
 * Entries are trimmed because a few plumbing commands (`for-each-ref` with a
 * `%00`-terminated format, for one) still append their own newline, which would
 * otherwise ride along on the front of the next entry.
 */
export function splitZ(output: string): string[] {
  return output
    .split('\0')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
