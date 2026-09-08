import { createHash, randomUUID } from 'node:crypto';

export { deriveCompatibilityLineageId } from '@pi-dashboard/protocol/dashboard-api';

/** Create an opaque identity for a durable delegate invocation or lineage. */
export function createOpaqueId(): string {
  return randomUUID();
}

/**
 * Old persisted tool details had no invocation identity. Include the stable
 * run facts available at that boundary so replay produces the same identity.
 */
export function deriveCompatibilityRunId(run: {
  continuation?: string;
  task?: string;
  name?: string;
  context?: string;
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  backgroundJobId?: string;
}): string {
  return `dr-${createHash('sha256')
    .update(
      JSON.stringify({
        continuation: run.continuation,
        task: run.task,
        name: run.name,
        context: run.context,
        queuedAt: run.queuedAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        backgroundJobId: run.backgroundJobId,
      }),
    )
    .digest('hex')
    .slice(0, 32)}`;
}
