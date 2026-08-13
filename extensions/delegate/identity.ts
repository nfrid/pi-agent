import { createHash, randomUUID } from 'node:crypto';

/**
 * Browser-safe deterministic hash for compatibility identities. Keep this
 * tiny algorithm in sync with the dashboard-domain adapter.
 */
export function compatibilityHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

/** Create an opaque identity for a durable delegate invocation or lineage. */
export function createOpaqueId(): string {
  return randomUUID();
}

/**
 * Legacy session metadata had no lineage field. Derive a stable opaque value
 * from its continuation token without rewriting the metadata file.
 */
export function deriveCompatibilityLineageId(token: string): string {
  return `dl-${compatibilityHash(`delegate-lineage:${token}`)}`;
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
