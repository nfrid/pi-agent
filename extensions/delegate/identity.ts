import { createHash, randomUUID } from 'node:crypto';

/** Create an opaque identity for a durable delegate invocation or lineage. */
export function createOpaqueId(): string {
  return randomUUID();
}

/**
 * Legacy session metadata had no lineage field. Derive a stable opaque value
 * from its continuation token without rewriting the metadata file.
 */
export function deriveCompatibilityLineageId(token: string): string {
  return `dl-${createHash('sha256')
    .update(`delegate-lineage:${token}`)
    .digest('hex')
    .slice(0, 32)}`;
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
