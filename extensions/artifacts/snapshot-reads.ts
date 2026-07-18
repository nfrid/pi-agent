import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { DEFAULT_MAX_LINES } from '@earendil-works/pi-coding-agent';
import { putArtifact, resolveArtifact } from './storage';

export const SNAPSHOT_READS_FLAG = 'snapshot-reads';
export const SNAPSHOT_DETAILS_KEY = 'artifacts.readSnapshot:v1';

export interface ReadSnapshotDetails {
  version: 1;
  snapshotId: string;
  key: string;
  digest: string;
  handle: string;
  unchanged?: boolean;
  suppressedBytes?: number;
}

export interface ReadSnapshotState {
  byKey: Map<string, ReadSnapshotDetails>;
}

type SnapshotContext = Pick<ExtensionContext, 'cwd' | 'sessionManager'>;
type SnapshotPi = Pick<ExtensionAPI, 'appendEntry'>;
type SnapshotResult = {
  content?: ToolResultEvent['content'];
  details?: unknown;
  isError?: boolean;
};

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Canonical selection identity; it deliberately describes a selection, not a file. */
export function normalizeReadSelection(
  cwd: string,
  input: Record<string, unknown>,
): string | undefined {
  if (typeof input.path !== 'string') return undefined;
  const offset = input.offset === undefined ? 1 : input.offset;
  const limit = input.limit === undefined ? DEFAULT_MAX_LINES : input.limit;
  if (typeof offset !== 'number' || typeof limit !== 'number') return undefined;
  return JSON.stringify({
    path: path.normalize(path.resolve(cwd, input.path)),
    offset,
    limit,
  });
}

export function readSnapshotDigest(text: string): string {
  return sha256(text);
}

export function readSnapshotId(key: string, digest: string): string {
  return `read_${sha256(`${key}\0${digest}`).slice(0, 16)}`;
}

function snapshotDetails(value: unknown): ReadSnapshotDetails | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const details = (value as Record<string, unknown>)[SNAPSHOT_DETAILS_KEY];
  if (!details || typeof details !== 'object') return undefined;
  const candidate = details as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.snapshotId !== 'string' ||
    typeof candidate.key !== 'string' ||
    typeof candidate.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.digest) ||
    typeof candidate.handle !== 'string' ||
    !/^art_[A-Za-z0-9_-]{22}$/.test(candidate.handle) ||
    (candidate.unchanged !== undefined &&
      typeof candidate.unchanged !== 'boolean') ||
    (candidate.suppressedBytes !== undefined &&
      (typeof candidate.suppressedBytes !== 'number' ||
        !Number.isSafeInteger(candidate.suppressedBytes) ||
        candidate.suppressedBytes < 0))
  )
    return undefined;
  return candidate as unknown as ReadSnapshotDetails;
}

/** Rebuild only from tool results on the active branch, so tree changes cannot leak state. */
export function reconstructReadSnapshots(
  ctx: Pick<ExtensionContext, 'sessionManager'>,
): ReadSnapshotState {
  const byKey = new Map<string, ReadSnapshotDetails>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role !== 'toolResult' || message.toolName !== 'read') continue;
    const details = snapshotDetails(message.details);
    if (details) byKey.set(details.key, details);
  }
  return { byKey };
}

function withDetails(
  original: unknown,
  snapshot: ReadSnapshotDetails,
  outcome: Pick<ReadSnapshotDetails, 'unchanged' | 'suppressedBytes'>,
): Record<string, unknown> {
  return {
    ...(original && typeof original === 'object'
      ? (original as Record<string, unknown>)
      : {}),
    [SNAPSHOT_DETAILS_KEY]: { ...snapshot, ...outcome },
  };
}

function snapshotMarker(snapshot: ReadSnapshotDetails): string {
  return `\n\n[snapshot read selection ${snapshot.snapshotId}; exact artifact_retrieve handle=${snapshot.handle} mode=lines offset=0]`;
}

function unchangedMarker(snapshot: ReadSnapshotDetails): string {
  return `unchanged read selection since ${snapshot.snapshotId}; exact artifact_retrieve handle=${snapshot.handle} mode=lines offset=0`;
}

async function priorIsExact(
  ctx: SnapshotContext,
  prior: ReadSnapshotDetails,
  root?: string,
): Promise<boolean> {
  try {
    const resolved = await resolveArtifact(ctx, prior.handle, root);
    return (
      resolved?.metadata.sha256 === prior.digest &&
      sha256(resolved.bytes) === prior.digest
    );
  } catch {
    return false;
  }
}

/** Processes an already-completed built-in read. It never performs or suppresses file I/O. */
export async function processReadSnapshot(
  pi: SnapshotPi,
  ctx: SnapshotContext,
  state: ReadSnapshotState,
  event: ToolResultEvent,
  root?: string,
  assertCurrent?: () => void,
): Promise<SnapshotResult | undefined> {
  if (event.toolName !== 'read' || event.isError) return undefined;
  if (event.content.length !== 1 || event.content[0]?.type !== 'text')
    return undefined;
  const key = normalizeReadSelection(ctx.cwd, event.input);
  if (!key) return undefined;
  const text = event.content[0].text;
  const digest = readSnapshotDigest(text);
  const prior = state.byKey.get(key);
  if (prior?.digest === digest && (await priorIsExact(ctx, prior, root))) {
    return {
      content: [{ type: 'text', text: unchangedMarker(prior) }],
      details: withDetails(event.details, prior, {
        unchanged: true,
        suppressedBytes: Buffer.byteLength(text, 'utf8'),
      }),
    };
  }

  // A missing/corrupt prior is fail-open: preserve the fresh result and establish a
  // new independently verifiable snapshot instead of emitting an unchanged claim.
  let metadata: Awaited<ReturnType<typeof putArtifact>>;
  try {
    metadata = await putArtifact(
      pi,
      ctx,
      {
        bytes: text,
        producer: 'tool',
        contentClass: 'tool-output',
        mediaType: 'text/plain; charset=utf-8',
        creationSource: 'read.snapshot',
      },
      root,
      assertCurrent,
    );
  } catch {
    return undefined;
  }
  assertCurrent?.();
  const snapshot: ReadSnapshotDetails = {
    version: 1,
    snapshotId: readSnapshotId(key, digest),
    key,
    digest,
    handle: metadata.handle,
  };
  state.byKey.set(key, snapshot);
  return {
    content: [
      {
        type: 'text',
        text: `${text}${snapshotMarker(snapshot)}`,
      },
    ],
    details: withDetails(event.details, snapshot, {
      unchanged: false,
      suppressedBytes: 0,
    }),
  };
}

export function registerSnapshotReads(
  pi: ExtensionAPI,
  options: { registerToolResult?: boolean } = {},
) {
  pi.registerFlag(SNAPSHOT_READS_FLAG, {
    type: 'boolean',
    default: false,
    description: 'Enable exact repeated-read snapshot references',
  });

  let state: ReadSnapshotState = { byKey: new Map() };
  let queue = Promise.resolve();
  let generation = 0;
  const rebuild = (ctx: ExtensionContext) => {
    generation++;
    state = reconstructReadSnapshots(ctx);
  };
  pi.on('session_start', (_event, ctx) => rebuild(ctx));
  pi.on('session_tree', (_event, ctx) => rebuild(ctx));
  pi.on('session_shutdown', () => {
    generation++;
    state = { byKey: new Map() };
  });
  const transformToolResult = (
    event: Parameters<typeof processReadSnapshot>[3],
    ctx: ExtensionContext,
  ) => {
    if (pi.getFlag(SNAPSHOT_READS_FLAG) !== true || event.toolName !== 'read')
      return;
    const scheduledGeneration = generation;
    const scheduledState = state;
    const guardedPi: SnapshotPi = {
      appendEntry(customType, data) {
        if (scheduledGeneration !== generation)
          throw new Error('Stale read snapshot lifecycle generation');
        return pi.appendEntry(customType, data);
      },
    };
    const work = queue.then(async () => {
      if (scheduledGeneration !== generation) return undefined;
      const result = await processReadSnapshot(
        guardedPi,
        ctx,
        scheduledState,
        event,
        undefined,
        () => {
          if (scheduledGeneration !== generation)
            throw new Error('Stale read snapshot lifecycle generation');
        },
      );
      return scheduledGeneration === generation ? result : undefined;
    });
    queue = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  };
  if (options.registerToolResult !== false)
    pi.on('tool_result', transformToolResult);
  return transformToolResult;
}
