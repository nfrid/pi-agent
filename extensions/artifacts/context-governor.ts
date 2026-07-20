import { createHash } from 'node:crypto';
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { resolveArtifact } from './storage';
import { utf8Head, utf8Tail } from './utf8-boundary';
import {
  type ArtifactResolver,
  resolveVerifiedArtifact,
} from './verified-resolution';

type AgentMessage = ContextEvent['messages'][number];

export const CONTEXT_GOVERNOR_FLAG = 'context-governor';
export const CONTEXT_GOVERNOR_PREVIEW_FLAG = 'context-governor-preview-bytes';
export const CONTEXT_GOVERNOR_DETAILS_KEY = 'artifacts.contextGovernor:v1';
export const CONTEXT_GOVERNOR_METRICS_ENTRY =
  'artifact-context-governor-metrics:v1';
export const CONTEXT_GOVERNOR_PREVIEW_BYTES = 2 * 1024;
export const MIN_CONTEXT_GOVERNOR_PREVIEW_BYTES = 512;
export const MAX_CONTEXT_GOVERNOR_PREVIEW_BYTES = 16 * 1024;
const TRUSTED_WEB_TOOLS = new Set([
  'web_search',
  'fetch_content',
  'get_search_content',
]);

type GovernorContext = Pick<ExtensionContext, 'sessionManager'>;
type Resolver = ArtifactResolver;

export interface ContextGovernorMarker {
  version: 1;
  handle: string;
  artifactSha256: string;
  inlineSha256: string;
  tool: string;
  retrieval: string;
  originalBytes: number;
  previewBytes: number;
}

export interface GovernorCounters {
  calls: number;
  transformed: number;
  retainedBytes: number;
  reclaimedBytes: number;
  failOpen: number;
  verificationMs: number;
}

export function contextGovernorPreviewBytes(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) &&
    parsed >= MIN_CONTEXT_GOVERNOR_PREVIEW_BYTES &&
    parsed <= MAX_CONTEXT_GOVERNOR_PREVIEW_BYTES
    ? parsed
    : CONTEXT_GOVERNOR_PREVIEW_BYTES;
}

export function emptyGovernorCounters(): GovernorCounters {
  return {
    calls: 0,
    transformed: 0,
    retainedBytes: 0,
    reclaimedBytes: 0,
    failOpen: 0,
    verificationMs: 0,
  };
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function artifactReference(
  event: ToolResultEvent,
): { handle: string; sha256: string } | undefined {
  const details = object(event.details);
  if (!details) return undefined;
  if (TRUSTED_WEB_TOOLS.has(event.toolName)) {
    const artifact = object(details.artifact);
    if (
      typeof artifact?.handle === 'string' &&
      typeof artifact.sha256 === 'string'
    ) {
      return { handle: artifact.handle, sha256: artifact.sha256 };
    }
    return undefined;
  }
  if (event.toolName === 'read') {
    const snapshot = object(details['artifacts.readSnapshot:v1']);
    if (
      typeof snapshot?.handle === 'string' &&
      typeof snapshot.digest === 'string'
    ) {
      return { handle: snapshot.handle, sha256: snapshot.digest };
    }
  }
  return undefined;
}

/** Closed eligibility predicate: anything uncertain remains inline. */
export function eligibleGovernorResult(event: ToolResultEvent): boolean {
  if (
    event.isError ||
    (!TRUSTED_WEB_TOOLS.has(event.toolName) && event.toolName !== 'read')
  )
    return false;
  if (event.content.length !== 1 || event.content[0]?.type !== 'text')
    return false;
  const details = object(event.details);
  if (
    details?.error !== undefined ||
    (typeof details?.failed === 'number' && details.failed > 0)
  )
    return false;
  return artifactReference(event) !== undefined;
}

/** Mark a result only after its session-scoped artifact is resolved and hash-verified. */
export async function markGovernorResult(
  event: ToolResultEvent,
  ctx: GovernorContext,
  resolver: Resolver = resolveArtifact,
  previewBytes = CONTEXT_GOVERNOR_PREVIEW_BYTES,
): Promise<{ details: Record<string, unknown> } | undefined> {
  if (!eligibleGovernorResult(event)) return undefined;
  const reference = artifactReference(event);
  const text =
    event.content[0]?.type === 'text' ? event.content[0].text : undefined;
  if (!reference || text === undefined) return undefined;
  try {
    if (
      !(await resolveVerifiedArtifact(
        ctx,
        reference.handle,
        reference.sha256,
        resolver,
      ))
    )
      return undefined;
  } catch {
    return undefined;
  }
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= previewBytes) return undefined;
  const marker: ContextGovernorMarker = {
    version: 1,
    handle: reference.handle,
    artifactSha256: reference.sha256,
    inlineSha256: sha256(text),
    tool: event.toolName,
    retrieval: `artifact_retrieve handle=${reference.handle} mode=lines offset=0`,
    originalBytes,
    previewBytes,
  };
  return {
    details: {
      ...(object(event.details) ?? {}),
      [CONTEXT_GOVERNOR_DETAILS_KEY]: marker,
    },
  };
}

export function parseGovernorMarker(
  value: unknown,
): ContextGovernorMarker | undefined {
  const marker = object(object(value)?.[CONTEXT_GOVERNOR_DETAILS_KEY]);
  if (
    marker?.version !== 1 ||
    typeof marker.handle !== 'string' ||
    !/^art_[A-Za-z0-9_-]{22}$/.test(marker.handle) ||
    typeof marker.artifactSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(marker.artifactSha256) ||
    typeof marker.inlineSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(marker.inlineSha256) ||
    typeof marker.tool !== 'string' ||
    (!TRUSTED_WEB_TOOLS.has(marker.tool) && marker.tool !== 'read') ||
    typeof marker.retrieval !== 'string' ||
    marker.retrieval !==
      `artifact_retrieve handle=${marker.handle} mode=lines offset=0` ||
    typeof marker.originalBytes !== 'number' ||
    !Number.isSafeInteger(marker.originalBytes) ||
    marker.originalBytes < 0 ||
    typeof marker.previewBytes !== 'number' ||
    !Number.isSafeInteger(marker.previewBytes) ||
    marker.previewBytes < MIN_CONTEXT_GOVERNOR_PREVIEW_BYTES ||
    marker.previewBytes > MAX_CONTEXT_GOVERNOR_PREVIEW_BYTES
  )
    return undefined;
  return marker as unknown as ContextGovernorMarker;
}

/** Fixed byte policy, independent of model token use. */
export function renderGovernedPreview(
  text: string,
  marker: ContextGovernorMarker,
  previewBytes = marker.previewBytes,
): { text: string; retainedBytes: number; reclaimedBytes: number } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= previewBytes) {
    return { text, retainedBytes: bytes.length, reclaimedBytes: 0 };
  }
  const half = Math.floor(previewBytes / 2);
  const head = utf8Head(bytes, half);
  const tail = utf8Tail(bytes, previewBytes - half);
  const retainedOriginalBytes =
    Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8');
  const omitted = bytes.length - retainedOriginalBytes;
  const rendered = `${head}\n\n[Truncated: omitted ${omitted} UTF-8 bytes. Exact retrieval: ${marker.retrieval}]\n\n${tail}`;
  const retainedBytes = Buffer.byteLength(rendered, 'utf8');
  const reclaimed = bytes.length - retainedBytes;
  if (reclaimed <= 0 || retainedBytes + reclaimed !== bytes.length) {
    return { text, retainedBytes: bytes.length, reclaimedBytes: 0 };
  }
  return { text: rendered, retainedBytes, reclaimedBytes: reclaimed };
}

export async function governContextMessages(
  messages: AgentMessage[],
  ctx: GovernorContext,
  counters: GovernorCounters,
  resolver: Resolver = resolveArtifact,
): Promise<AgentMessage[]> {
  counters.calls += 1;
  return Promise.all(
    messages.map(async (message) => {
      if (message.role !== 'toolResult' || message.isError) return message;
      const marker = parseGovernorMarker(message.details);
      if (!marker || marker.tool !== message.toolName) return message;
      if (message.content.length !== 1 || message.content[0]?.type !== 'text')
        return message;
      const text = message.content[0].text;
      if (
        Buffer.byteLength(text, 'utf8') !== marker.originalBytes ||
        sha256(text) !== marker.inlineSha256
      ) {
        counters.failOpen += 1;
        return message;
      }
      const verificationStarted = performance.now();
      try {
        const artifact = await resolveVerifiedArtifact(
          ctx,
          marker.handle,
          marker.artifactSha256,
          resolver,
        );
        if (!artifact) {
          counters.failOpen += 1;
          return message;
        }
      } catch {
        counters.failOpen += 1;
        return message;
      } finally {
        counters.verificationMs += performance.now() - verificationStarted;
      }
      const preview = renderGovernedPreview(text, marker);
      counters.retainedBytes += preview.retainedBytes;
      counters.reclaimedBytes += preview.reclaimedBytes;
      if (preview.reclaimedBytes === 0) return message;
      counters.transformed += 1;
      return {
        ...message,
        content: [{ type: 'text' as const, text: preview.text }],
      };
    }),
  );
}

export function registerContextGovernor(
  pi: ExtensionAPI,
  options: { registerToolResult?: boolean } = {},
) {
  pi.registerFlag(CONTEXT_GOVERNOR_FLAG, {
    type: 'boolean',
    default: false,
    description: 'Opt in to verified artifact-backed context previews',
  });
  pi.registerFlag(CONTEXT_GOVERNOR_PREVIEW_FLAG, {
    type: 'string',
    default: String(CONTEXT_GOVERNOR_PREVIEW_BYTES),
    description: `Artifact context preview bytes (${MIN_CONTEXT_GOVERNOR_PREVIEW_BYTES}-${MAX_CONTEXT_GOVERNOR_PREVIEW_BYTES})`,
  });

  let counters = emptyGovernorCounters();
  let lastPersisted = '';
  const reset = () => {
    counters = emptyGovernorCounters();
    lastPersisted = '';
  };
  pi.on('session_start', reset);
  const transformToolResult = (
    event: Parameters<typeof markGovernorResult>[0],
    ctx: ExtensionContext,
  ) => {
    if (pi.getFlag(CONTEXT_GOVERNOR_FLAG) !== true) return;
    return markGovernorResult(
      event,
      ctx,
      resolveArtifact,
      contextGovernorPreviewBytes(pi.getFlag(CONTEXT_GOVERNOR_PREVIEW_FLAG)),
    );
  };
  if (options.registerToolResult !== false)
    pi.on('tool_result', transformToolResult);
  pi.on('context', async (event: ContextEvent, ctx) => {
    if (pi.getFlag(CONTEXT_GOVERNOR_FLAG) !== true) return;
    return {
      messages: await governContextMessages(event.messages, ctx, counters),
    };
  });
  pi.on('agent_settled', () => {
    if (pi.getFlag(CONTEXT_GOVERNOR_FLAG) !== true || counters.calls === 0)
      return;
    const data = {
      version: 1,
      at: new Date().toISOString(),
      previewBytes: contextGovernorPreviewBytes(
        pi.getFlag(CONTEXT_GOVERNOR_PREVIEW_FLAG),
      ),
      counters: { ...counters },
    };
    const identity = JSON.stringify({
      previewBytes: data.previewBytes,
      counters: data.counters,
    });
    if (identity === lastPersisted) return;
    pi.appendEntry(CONTEXT_GOVERNOR_METRICS_ENTRY, data);
    lastPersisted = identity;
  });
  pi.registerCommand('context-governor', {
    description: 'Show model-invisible artifact context governor diagnostics.',
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Context governor ${pi.getFlag(CONTEXT_GOVERNOR_FLAG) === true ? 'enabled' : 'disabled'}: preview=${contextGovernorPreviewBytes(pi.getFlag(CONTEXT_GOVERNOR_PREVIEW_FLAG))} bytes, calls=${counters.calls}, transformed=${counters.transformed}, retained=${counters.retainedBytes} bytes, reclaimed=${counters.reclaimedBytes} bytes, fail-open=${counters.failOpen}, verification=${counters.verificationMs.toFixed(1)} ms cumulative.`,
        'info',
      );
    },
  });
  return transformToolResult;
}
