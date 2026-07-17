import * as path from 'node:path';
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { loadIsolation } from '../delegate/isolation';
import { resolveDelegateSession } from '../delegate/session';
import {
  canonicalPath,
  isInside,
  isTrustedRepository,
  repositoryRootForPath,
  scanNestedRepositories,
} from './scope';
import type {
  AutonomyProfile,
  Capability,
  CapabilityEnvelope,
  EnvelopeDelta,
  EnvelopeProposal,
  LegacyCapabilityEnvelope,
  PolicyDecision,
  RepositoryAuthority,
} from './types';

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function normalizeAuthority(
  authority: RepositoryAuthority,
): RepositoryAuthority {
  return {
    root: authority.root,
    scopes: Object.fromEntries(
      Object.entries(authority.scopes).map(([capability, paths]) => [
        capability,
        unique(paths ?? []),
      ]),
    ) as RepositoryAuthority['scopes'],
  };
}

export function createEnvelope(options: {
  repositoryRoot: string;
  paths?: string[];
  capabilities?: Capability[];
  source: CapabilityEnvelope['source'];
  ttlMs?: number;
  now?: number;
}): CapabilityEnvelope {
  const now = options.now ?? Date.now();
  const root = repositoryRootForPath(options.repositoryRoot);
  const paths = (options.paths?.length ? options.paths : ['.']).map((entry) => {
    const target = canonicalPath(root, entry);
    if (!isInside(root, target))
      throw new Error(`scope escapes repository: ${entry}`);
    return target;
  });
  return {
    version: 2,
    repositories: [
      {
        root,
        scopes: Object.fromEntries(
          unique(options.capabilities ?? (['inspect'] as Capability[])).map(
            (capability) => [capability, unique(paths)],
          ),
        ),
      },
    ],
    confirmations: ['deliver', 'destructive'],
    source: options.source,
    createdAt: now,
    ...(options.ttlMs ? { expiresAt: now + options.ttlMs } : {}),
  };
}

export function migrateEnvelope(
  envelope: CapabilityEnvelope | LegacyCapabilityEnvelope,
): CapabilityEnvelope {
  if (envelope.version === 2)
    return {
      ...envelope,
      repositories: envelope.repositories.map(normalizeAuthority),
    };
  return {
    version: 2,
    repositories: [
      {
        root: envelope.repositoryRoot,
        scopes: Object.fromEntries(
          unique(envelope.capabilities).map((capability) => [
            capability,
            unique(envelope.paths),
          ]),
        ),
      },
    ],
    confirmations: envelope.confirmations,
    source: envelope.source,
    createdAt: envelope.createdAt,
    ...(envelope.expiresAt ? { expiresAt: envelope.expiresAt } : {}),
  };
}

function deny(
  code: PolicyDecision['code'],
  reason: string,
  capability?: Capability,
  target?: string,
): PolicyDecision {
  return { allowed: false, code, reason, capability, target };
}

function allow(capability?: Capability, target?: string): PolicyDecision {
  return {
    allowed: true,
    code: 'allowed',
    reason: 'allowed',
    capability,
    target,
  };
}

function checkExpiry(
  envelope: CapabilityEnvelope,
  capability: Capability,
  now: number,
): PolicyDecision | undefined {
  if (envelope.expiresAt !== undefined && now >= envelope.expiresAt)
    return deny(
      'expired-envelope',
      'Capability envelope has expired.',
      capability,
    );
}

export function repositoryAuthorityForTarget(
  envelope: CapabilityEnvelope,
  target: string,
): RepositoryAuthority | undefined {
  return envelope.repositories
    .filter((authority) => isInside(authority.root, target))
    .sort((left, right) => right.root.length - left.root.length)[0];
}

export function nestedRepositoryBoundary(
  envelope: CapabilityEnvelope,
  target: string,
): { unauthorized: string[]; complete: boolean } {
  const authority = repositoryAuthorityForTarget(envelope, target);
  if (!authority) return { unauthorized: [], complete: false };
  const scan = scanNestedRepositories(authority.root);
  return {
    unauthorized: scan.roots.filter(
      (nested) =>
        isInside(target, nested) &&
        !envelope.repositories.some(
          (candidate) =>
            candidate.root === nested &&
            candidate.scopes.inspect?.includes(candidate.root),
        ),
    ),
    complete: scan.complete,
  };
}

function checkTarget(
  envelope: CapabilityEnvelope,
  cwd: string,
  rawTarget: unknown,
  capability: Capability,
  now: number,
): PolicyDecision {
  const expired = checkExpiry(envelope, capability, now);
  if (expired) return expired;
  if (typeof rawTarget !== 'string')
    return deny('invalid-target', 'Tool target path is missing.', capability);
  let target: string;
  try {
    target = canonicalPath(cwd, rawTarget);
  } catch (error) {
    return deny(
      'invalid-target',
      error instanceof Error ? error.message : String(error),
      capability,
    );
  }
  const authority = repositoryAuthorityForTarget(envelope, target);
  if (
    authority &&
    capability === 'edit' &&
    path.relative(authority.root, target).split(path.sep)[0] === '.git'
  )
    return deny(
      'missing-capability',
      'Git metadata writes require independent local-git authority and a mediated Git action.',
      'local-git',
      target,
    );
  if (authority && repositoryRootForPath(target) !== authority.root)
    return deny(
      'outside-scope',
      'A nested repository requires its own independent authority lease.',
      capability,
      target,
    );
  if (!authority?.scopes[capability])
    return deny(
      authority ? 'missing-capability' : 'outside-scope',
      authority
        ? `Capability ${capability} is not present for the target repository.`
        : 'Tool target is outside the active repository authorities.',
      capability,
      target,
    );
  if (
    !(authority.scopes[capability] ?? []).some((root) => isInside(root, target))
  )
    return deny(
      'outside-scope',
      'Tool target is outside the active capability scope.',
      capability,
      target,
    );
  return allow(capability, target);
}

function hasCapability(
  envelope: CapabilityEnvelope,
  capability: Capability,
  now: number,
): PolicyDecision | undefined {
  const expired = checkExpiry(envelope, capability, now);
  if (expired) return expired;
  if (!envelope.repositories.some((item) => item.scopes[capability]))
    return deny(
      'missing-capability',
      `Capability ${capability} is not present in the active envelope.`,
      capability,
    );
}

function delegateDecision(
  event: ToolCallEvent,
  envelope: CapabilityEnvelope,
  cwd: string,
  now: number,
): PolicyDecision | undefined {
  if (event.toolName !== 'delegate') return;
  const input = event.input as Record<string, unknown>;
  const topWrites = input.allowWrites === true;
  const tasks = Array.isArray(input.tasks)
    ? (input.tasks as Array<Record<string, unknown>>)
    : [];
  const topScope = Array.isArray(input.scope) ? input.scope : [];
  const candidates = tasks.length > 0 ? tasks : [input];
  for (const task of candidates) {
    const continuation = task.continuation ?? input.continuation;
    const session =
      typeof continuation === 'string'
        ? resolveDelegateSession(continuation)
        : undefined;
    if (typeof continuation === 'string' && !session)
      return deny(
        'invalid-target',
        'Delegate continuation cannot be resolved for scope enforcement.',
        'inspect',
      );
    const isolation = session?.isolationId
      ? loadIsolation(session.isolationId)
      : undefined;
    const taskCwd = isolation
      ? isolation.repositoryRoot
      : (session?.cwd ??
        (typeof task.cwd === 'string'
          ? task.cwd
          : typeof input.cwd === 'string'
            ? input.cwd
            : cwd));
    const inspectTarget = checkTarget(envelope, cwd, taskCwd, 'inspect', now);
    if (!inspectTarget.allowed) return inspectTarget;
    const authority = repositoryAuthorityForTarget(
      envelope,
      inspectTarget.target as string,
    );
    if (!authority?.scopes.inspect?.includes(authority.root))
      return deny(
        'unsupported-tool',
        'Delegation requires repository-root inspect authority because child reads are repository-wide.',
        'inspect',
      );
    const nestedBoundary = nestedRepositoryBoundary(envelope, authority.root);
    if (!nestedBoundary.complete || nestedBoundary.unauthorized.length > 0)
      return deny(
        'unsupported-tool',
        'Delegation would expose nested repositories without complete independent inspect leases.',
        'inspect',
        authority.root,
      );

    const writes =
      typeof task.allowWrites === 'boolean' ? task.allowWrites : topWrites;
    if (!writes) continue;
    let scopes = Array.isArray(task.scope) ? task.scope : topScope;
    let scopeCwd = taskCwd;
    if (scopes.length === 0 && typeof continuation === 'string') {
      if (!isolation)
        return deny(
          'write-scope-required',
          'Writable continuation scope cannot be resolved.',
          'edit',
        );
      scopes = isolation.requestedScopes;
      scopeCwd = isolation.repositoryRoot;
    }
    if (scopes.length === 0 && typeof continuation !== 'string')
      return deny(
        'write-scope-required',
        'Writable delegation requires at least one enforced scope directory.',
        'edit',
      );
    for (const scope of scopes) {
      const decision = checkTarget(envelope, scopeCwd, scope, 'edit', now);
      if (!decision.allowed) return decision;
    }
  }
  return allow();
}

function sandboxShellDecision(
  event: ToolCallEvent,
  envelope: CapabilityEnvelope,
  cwd: string,
  now: number,
): PolicyDecision | undefined {
  if (event.toolName !== 'sandbox_shell') return;
  const input = event.input as Record<string, unknown>;
  const shellCwd = typeof input.cwd === 'string' ? input.cwd : cwd;
  const mode =
    input.mode === 'edit'
      ? 'edit'
      : input.mode === 'validate'
        ? 'validate'
        : 'inspect';
  const base = checkTarget(envelope, cwd, shellCwd, 'inspect', now);
  if (!base.allowed) return base;
  const authority = repositoryAuthorityForTarget(
    envelope,
    base.target as string,
  );
  if (
    mode !== 'inspect' &&
    !authority?.scopes.inspect?.includes(authority.root)
  )
    return deny(
      'unsupported-tool',
      'Transactional shell modes require repository-root inspect authority because the snapshot contains the current repository state.',
      'inspect',
    );
  if (mode !== 'inspect' && authority) {
    const nestedBoundary = nestedRepositoryBoundary(envelope, authority.root);
    if (!nestedBoundary.complete || nestedBoundary.unauthorized.length > 0)
      return deny(
        'unsupported-tool',
        'Transactional shell execution would expose nested repositories without complete independent inspect leases.',
        'inspect',
        authority.root,
      );
  }
  if (mode !== 'edit') return base;
  const scopes = Array.isArray(input.scope) ? input.scope : [];
  if (scopes.length === 0)
    return deny(
      'write-scope-required',
      'Transactional shell edits require at least one scope path.',
      'edit',
    );
  for (const scope of scopes) {
    const decision = checkTarget(envelope, shellCwd, scope, 'edit', now);
    if (!decision.allowed) return decision;
  }
  return allow('edit', base.target);
}

export function decideToolCall(
  event: ToolCallEvent,
  rawEnvelope: CapabilityEnvelope,
  cwd: string,
  now = Date.now(),
): PolicyDecision {
  const envelope = migrateEnvelope(rawEnvelope);
  const delegated = delegateDecision(event, envelope, cwd, now);
  if (delegated) return delegated;
  const shell = sandboxShellDecision(event, envelope, cwd, now);
  if (shell) return shell;

  if (event.toolName === 'bash')
    return deny(
      'uncontrolled-shell',
      'Uncontained Bash is disabled while capability enforcement is active. Use sandbox_shell, which supports Bash syntax inside an effect-constrained macOS sandbox.',
    );

  if (event.toolName === 'edit' || event.toolName === 'write')
    return checkTarget(envelope, cwd, event.input.path, 'edit', now);

  if (
    event.toolName === 'read' ||
    event.toolName === 'grep' ||
    event.toolName === 'find' ||
    event.toolName === 'ls'
  ) {
    const target = (event.input as Record<string, unknown>).path;
    const decision = checkTarget(envelope, cwd, target ?? '.', 'inspect', now);
    const nestedBoundary = decision.allowed
      ? nestedRepositoryBoundary(envelope, decision.target as string)
      : undefined;
    if (
      decision.allowed &&
      (event.toolName === 'grep' || event.toolName === 'find') &&
      (!nestedBoundary?.complete ||
        (nestedBoundary?.unauthorized.length ?? 0) > 0)
    )
      return deny(
        'unsupported-tool',
        'Recursive inspection would cross into a nested repository without an independent inspect lease.',
        'inspect',
        decision.target,
      );
    return decision;
  }

  if (
    event.toolName === 'repository_navigate' ||
    event.toolName === 'todo_schedule'
  ) {
    const decision = checkTarget(envelope, cwd, '.', 'inspect', now);
    if (!decision.allowed) return decision;
    const nestedBoundary = nestedRepositoryBoundary(
      envelope,
      decision.target as string,
    );
    if (!nestedBoundary.complete || nestedBoundary.unauthorized.length > 0)
      return deny(
        'unsupported-tool',
        `${event.toolName} would cross nested repositories without complete independent inspect leases.`,
        'inspect',
        decision.target,
      );
    return decision;
  }

  if (
    event.toolName === 'artifact_retrieve' ||
    event.toolName === 'web_search' ||
    event.toolName === 'fetch_content' ||
    event.toolName === 'get_search_content'
  )
    return checkTarget(envelope, cwd, '.', 'inspect', now);

  if (
    event.toolName === 'todo' ||
    event.toolName === 'ask_user_question' ||
    event.toolName === 'autonomy_propose'
  )
    return allow();

  return deny(
    'unsupported-tool',
    `Tool ${event.toolName} has no capability policy and is blocked while enforcement is active.`,
  );
}

function flattenedCapabilities(envelope: CapabilityEnvelope): Capability[] {
  return unique(
    envelope.repositories.flatMap(
      (item) => Object.keys(item.scopes) as Capability[],
    ),
  );
}

function scopeRecords(envelope: CapabilityEnvelope): Array<{
  repository: string;
  capability: Capability;
  path: string;
}> {
  return envelope.repositories.flatMap((item) =>
    Object.entries(item.scopes).flatMap(([capability, paths]) =>
      (paths ?? []).map((scope) => ({
        repository: item.root,
        capability: capability as Capability,
        path: scope,
      })),
    ),
  );
}

export function diffEnvelopes(
  rawCurrent: CapabilityEnvelope,
  rawProposed: CapabilityEnvelope,
): EnvelopeDelta {
  const current = migrateEnvelope(rawCurrent);
  const proposed = migrateEnvelope(rawProposed);
  const currentCapabilities = flattenedCapabilities(current);
  const proposedCapabilities = flattenedCapabilities(proposed);
  const currentRoots = current.repositories.map((item) => item.root);
  const proposedRoots = proposed.repositories.map((item) => item.root);
  const currentScopes = scopeRecords(current);
  const proposedScopes = scopeRecords(proposed);
  return {
    addedCapabilities: proposedCapabilities.filter(
      (capability) => !currentCapabilities.includes(capability),
    ),
    removedCapabilities: currentCapabilities.filter(
      (capability) => !proposedCapabilities.includes(capability),
    ),
    addedRepositories: proposedRoots.filter(
      (root) => !currentRoots.includes(root),
    ),
    removedRepositories: currentRoots.filter(
      (root) => !proposedRoots.includes(root),
    ),
    expandedPaths: unique(
      proposedScopes
        .filter(
          (candidate) =>
            !currentScopes.some(
              (existing) =>
                existing.repository === candidate.repository &&
                existing.capability === candidate.capability &&
                isInside(existing.path, candidate.path),
            ),
        )
        .map((item) => item.path),
    ),
    narrowedPaths: unique(
      currentScopes
        .filter(
          (candidate) =>
            !proposedScopes.some(
              (existing) =>
                existing.repository === candidate.repository &&
                existing.capability === candidate.capability &&
                isInside(existing.path, candidate.path),
            ),
        )
        .map((item) => item.path),
    ),
    oldExpiresAt: current.expiresAt,
    newExpiresAt: proposed.expiresAt,
  };
}

export function isAuthorityExpansion(delta: EnvelopeDelta): boolean {
  const ttlExpanded =
    delta.newExpiresAt === undefined
      ? delta.oldExpiresAt !== undefined
      : delta.oldExpiresAt !== undefined &&
        delta.newExpiresAt > delta.oldExpiresAt;
  return (
    delta.addedCapabilities.length > 0 ||
    delta.addedRepositories.length > 0 ||
    delta.expandedPaths.length > 0 ||
    ttlExpanded
  );
}

export function mergeProposal(
  rawCurrent: CapabilityEnvelope,
  proposal: EnvelopeProposal,
  now = Date.now(),
): CapabilityEnvelope {
  const current = migrateEnvelope(rawCurrent);
  const repositories = current.repositories.map((item) => ({
    ...item,
    scopes: Object.fromEntries(
      Object.entries(item.scopes).map(([capability, paths]) => [
        capability,
        [...(paths ?? [])],
      ]),
    ) as RepositoryAuthority['scopes'],
  }));
  const primaryRoot = repositories[0]?.root;
  if (!primaryRoot) throw new Error('Capability envelope has no repository');
  const requestedCapabilities = unique([
    ...proposal.capabilities,
    ...(proposal.capabilities.includes('edit')
      ? (['inspect'] as Capability[])
      : []),
  ]);
  for (const rawPath of proposal.paths) {
    const target = canonicalPath(primaryRoot, rawPath);
    const repositoryRoot = repositoryRootForPath(target);
    let authority = repositories.find((item) => item.root === repositoryRoot);
    if (!authority) {
      authority = { root: repositoryRoot, scopes: {} };
      repositories.push(authority);
    }
    for (const capability of requestedCapabilities)
      authority.scopes[capability] = unique([
        ...(authority.scopes[capability] ?? []),
        target,
      ]);
  }
  return {
    ...current,
    repositories: repositories.map(normalizeAuthority),
    source: 'agent-lease',
    createdAt: now,
    expiresAt:
      proposal.ttlMs !== undefined ? now + proposal.ttlMs : current.expiresAt,
  };
}

export function canAutoApproveProposal(
  rawCurrent: CapabilityEnvelope,
  rawProposed: CapabilityEnvelope,
  trustedRoots: string[],
  autoApprove: Capability[],
): boolean {
  const current = migrateEnvelope(rawCurrent);
  const proposed = migrateEnvelope(rawProposed);
  const expandedScopes = scopeRecords(proposed).filter(
    (candidate) =>
      !scopeRecords(current).some(
        (existing) =>
          existing.repository === candidate.repository &&
          existing.capability === candidate.capability &&
          isInside(existing.path, candidate.path),
      ),
  );
  if (expandedScopes.some((scope) => !autoApprove.includes(scope.capability)))
    return false;
  if (
    expandedScopes.some(
      (scope) => !isTrustedRepository(scope.repository, trustedRoots),
    )
  )
    return false;
  const ttlExpanded =
    proposed.expiresAt === undefined
      ? current.expiresAt !== undefined
      : current.expiresAt !== undefined &&
        proposed.expiresAt > current.expiresAt;
  return !ttlExpanded;
}

export function formatEnvelopeDelta(delta: EnvelopeDelta): string {
  return [
    `Capabilities +${delta.addedCapabilities.join(',') || 'none'} -${delta.removedCapabilities.join(',') || 'none'}`,
    `Repositories +${delta.addedRepositories.join(',') || 'none'} -${delta.removedRepositories.join(',') || 'none'}`,
    `Scope +${delta.expandedPaths.join(',') || 'none'} -${delta.narrowedPaths.join(',') || 'none'}`,
    `Expiry ${delta.oldExpiresAt ?? 'session'} -> ${delta.newExpiresAt ?? 'session'}`,
  ].join('\n');
}

export function decideCapabilityAction(
  capability: Extract<Capability, 'local-git' | 'deliver' | 'destructive'>,
  envelope: CapabilityEnvelope,
  profile: AutonomyProfile,
  confirmed = false,
  now = Date.now(),
): PolicyDecision {
  const missing = hasCapability(envelope, capability, now);
  if (missing) return missing;
  const confirmationRequired =
    capability === 'deliver' ||
    capability === 'destructive' ||
    (capability === 'local-git' && profile.confirmReversibleChoices);
  if (confirmationRequired && !confirmed)
    return deny(
      'confirmation-required',
      `${capability} requires explicit confirmation for profile ${profile.name}.`,
      capability,
    );
  return allow(capability);
}

export function formatEnvelope(rawEnvelope: CapabilityEnvelope): string {
  const envelope = migrateEnvelope(rawEnvelope);
  const ttl = envelope.expiresAt
    ? `expires ${new Date(envelope.expiresAt).toISOString()}`
    : 'session lifetime';
  const repositories = envelope.repositories.flatMap((authority) => [
    `Repository: ${authority.root}`,
    ...Object.entries(authority.scopes).map(
      ([capability, paths]) =>
        `  ${capability}: ${(paths ?? []).join(', ') || '(none)'}`,
    ),
  ]);
  return [
    `Profile envelope (${envelope.source}, ${ttl})`,
    ...repositories,
    `Always confirm: ${envelope.confirmations.join(', ')}`,
  ].join('\n');
}
