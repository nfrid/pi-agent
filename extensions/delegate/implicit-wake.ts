import { createHash } from 'node:crypto';
import type { WakeCoordinator, WakeSnapshot } from './wake-coordinator';
import type { DelegateWorkflowCoordinator } from './workflow-coordinator';

const ACTIVE_ATTEMPT_STATES = new Set(['scheduled', 'queued', 'running']);

/**
 * Install a non-obstructive fallback for locally owned attempts that have no
 * active explicit wake. The identity-derived ID makes repeated settlement and
 * reload reconciliation idempotent.
 */
export function registerImplicitAllSettledWake(options: {
  workflow: DelegateWorkflowCoordinator;
  wakes: WakeCoordinator;
  ownerBranchId: string;
}): WakeSnapshot | undefined {
  // Any explicit active subscription owns resumption for this idle boundary.
  // This also makes repeated calls idempotent once the implicit wake is armed.
  if (options.wakes.list().length > 0) return undefined;
  const references = options.workflow
    .list()
    .filter(
      (attempt) =>
        attempt.ownerBranchId === options.ownerBranchId &&
        ACTIVE_ATTEMPT_STATES.has(attempt.state),
    )
    .map((attempt) => attempt.identity)
    .sort();
  if (references.length === 0) return undefined;

  const digest = createHash('sha256')
    .update(references.join('\n'))
    .digest('hex')
    .slice(0, 20);
  const id = `implicit-all-${digest}`;
  const existing = options.wakes.get(id);
  if (existing) return existing;
  return options.wakes.register({
    id,
    condition:
      references.length === 1
        ? { node: references[0] as string }
        : { all: references },
    payload: ['metadata'],
    nonObstructive: true,
  });
}
