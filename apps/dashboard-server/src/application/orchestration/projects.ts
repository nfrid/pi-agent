import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  gitText,
  repositoryIdentity,
  repositoryRoot,
} from '@pi-dashboard/worktree-manager';
import type { CreateProjectCommand, OrchestrationHost } from './helpers.js';

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
  const workspace = command.workspaceId
    ? host.workspaces().find((item) => item.id === command.workspaceId)
    : undefined;
  const candidate = command.rootPath ?? workspace?.canonicalPath;
  if (!candidate) throw new Error('A rootPath or workspaceId is required.');
  const discoveredRoot = await repositoryRoot(candidate);
  const worktrees = await gitText(discoveredRoot, [
    'worktree',
    'list',
    '--porcelain',
  ]);
  const mainLine = worktrees
    .split('\n')
    .find((line: string) => line.startsWith('worktree '));
  const root = mainLine
    ? mainLine.slice('worktree '.length).trim()
    : discoveredRoot;
  const identity = await repositoryIdentity(candidate);
  const existing = host.repository.getProjectByRepositoryIdentity(identity);
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
  const branch = await gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const baseSha = await gitText(root, ['rev-parse', 'HEAD']);
  const now = Date.now();
  const projectInput = {
    title: command.title ?? path.basename(root),
    rootPath: root,
    repositoryIdentity: identity,
    // An inferred current branch is not a configured base selector. Keep
    // fresh worktrees on the current-WIP default unless explicitly supplied.
    defaultBaseBranch: command.defaultBaseBranch,
    defaultModel: command.defaultModel,
    defaultIsolation: command.defaultIsolation ?? 'worktree',
    maxParallelRuns: command.maxParallelRuns ?? 1,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const result = host.repository.createProjectWithCheckout(projectInput, {
      id: `checkout-${randomUUID()}`,
      kind: 'main',
      path: root,
      ...(branch === 'HEAD' ? {} : { branch }),
      baseSha,
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
    const winner = host.repository.getProjectByRepositoryIdentity(identity);
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
