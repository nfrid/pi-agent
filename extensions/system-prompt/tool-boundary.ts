import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/** Fail-closed filesystem boundary for delegated child tools. */
export function delegateToolBoundary(
  toolName: string,
  input: unknown,
  cwd: string,
): string | undefined {
  if (!['read', 'grep', 'find', 'ls', 'edit', 'write'].includes(toolName))
    return;
  const raw =
    typeof input === 'object' && input !== null && 'path' in input
      ? (input as { path?: unknown }).path
      : undefined;
  const requested = typeof raw === 'string' ? raw : '.';
  const root = realpathSync(cwd);
  const absolute = resolve(cwd, requested);
  let existing = absolute;
  while (!existsSync(existing) && dirname(existing) !== existing)
    existing = dirname(existing);
  const canonical = existsSync(existing)
    ? resolve(realpathSync(existing), relative(existing, absolute))
    : absolute;
  const fromRoot = relative(root, canonical);
  if (
    isAbsolute(fromRoot) ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  )
    return 'Delegate tools cannot access paths outside the delegated checkout.';
}
