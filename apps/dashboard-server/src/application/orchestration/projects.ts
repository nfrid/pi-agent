import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  gitText,
  repositoryIdentity,
  repositoryRoot,
} from '@pi-dashboard/worktree-manager';
import type { CreateProjectCommand, OrchestrationHost } from './helpers.js';

function isNotGitRepository(error: unknown): boolean {
  const stderr =
    typeof error === 'object' && error !== null && 'stderr' in error
      ? String(error.stderr)
      : '';
  const message = error instanceof Error ? error.message : String(error);
  return `${message}\n${stderr}`.includes('not a git repository');
}

export async function createProject(
  host: OrchestrationHost,
  command: CreateProjectCommand,
): Promise<unknown> {
  return adoptProject(host, command);
}

export async function adoptProject(
  host: OrchestrationHost,
  command: CreateProjectCommand,
): Promise<unknown> {
  const prior = host.receipt(command.commandId, 'project.adopt');
  if (prior) return prior.result;
  const candidate = command.rootPath;

  let candidateRoot: string;
  try {
    candidateRoot = realpathSync.native(candidate);
    if (!statSync(candidateRoot).isDirectory())
      throw new Error('not a directory');
  } catch {
    throw new Error('The adoption root must be an existing directory.');
  }

  let root: string;
  let identity: string | undefined;
  let branch: string | undefined;
  let baseSha: string | undefined;
  let discoveredRoot: string | undefined;
  try {
    discoveredRoot = await repositoryRoot(candidateRoot);
  } catch (error) {
    if (!isNotGitRepository(error)) throw error;
    discoveredRoot = undefined;
  }
  if (discoveredRoot) {
    const worktrees = await gitText(discoveredRoot, [
      'worktree',
      'list',
      '--porcelain',
    ]);
    const mainLine = worktrees
      .split('\n')
      .find((line: string) => line.startsWith('worktree '));
    root = realpathSync.native(
      mainLine ? mainLine.slice('worktree '.length).trim() : discoveredRoot,
    );
    identity = await repositoryIdentity(candidate);
    branch = await gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    baseSha = await gitText(root, ['rev-parse', 'HEAD']);
  } else root = candidateRoot;
  const existing = identity
    ? host.repository.getProjectByRepositoryIdentity(identity)
    : host.repository
        .listProjects()
        .filter((project) => project.repositoryIdentity === undefined)
        .find((project) => {
          try {
            return realpathSync.native(project.rootPath) === root;
          } catch {
            return path.resolve(project.rootPath) === root;
          }
        });
  if (existing) {
    const checkout = host.mainCheckout(existing.id);
    if (!checkout) throw new Error('Adopted project has no main checkout.');
    const result = { project: existing, checkout };
    const persisted = host.saveReceipt(
      command.commandId,
      'project.adopt',
      result,
    );
    return persisted as typeof result;
  }
  const now = Date.now();
  const projectInput = {
    title: command.title ?? path.basename(root),
    rootPath: root,
    ...(identity === undefined ? {} : { repositoryIdentity: identity }),
    // An inferred current branch is not a configured base selector. Keep
    // fresh worktrees on the current-WIP default unless explicitly supplied.
    defaultBaseBranch: command.defaultBaseBranch,
    defaultModel: command.defaultModel,
    defaultIsolation:
      identity === undefined
        ? 'main'
        : (command.defaultIsolation ?? 'worktree'),
    maxParallelRuns: command.maxParallelRuns ?? 1,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const result = host.repository.createProjectWithCheckout(projectInput, {
      id: `checkout-${randomUUID()}`,
      kind: 'main',
      path: root,
      ...(branch === undefined || branch === 'HEAD' ? {} : { branch }),
      ...(baseSha === undefined ? {} : { baseSha }),
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    });
    const persisted = host.saveReceipt(
      command.commandId,
      'project.adopt',
      result,
    );
    host.changed();
    return persisted as typeof result;
  } catch (error) {
    // The repository identity index serializes concurrent adopters. Read the
    // committed winner (including its main checkout) instead of leaving a
    // duplicate project or treating a harmless race as a failed command.
    const winner = identity
      ? host.repository.getProjectByRepositoryIdentity(identity)
      : host.repository
          .listProjects()
          .filter((project) => project.repositoryIdentity === undefined)
          .find((project) => {
            try {
              return realpathSync.native(project.rootPath) === root;
            } catch {
              return path.resolve(project.rootPath) === root;
            }
          });
    const checkout = winner && host.mainCheckout(winner.id);
    if (!winner || !checkout) throw error;
    const result = { project: winner, checkout };
    const persisted = host.saveReceipt(
      command.commandId,
      'project.adopt',
      result,
    );
    host.changed();
    return persisted as typeof result;
  }
}
