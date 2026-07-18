import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { registerContextGovernor } from './context-governor';
import { collectGarbage } from './gc';
import {
  RETRIEVAL_MODES,
  type RetrievalRequest,
  renderRetrievalResult,
  retrieveArtifact,
} from './retrieval';
import { registerSnapshotReads } from './snapshot-reads';
import {
  putArtifact,
  recoverArtifactFromEntries,
  restoreArtifacts,
  revokeArtifact,
} from './storage';

const registered = new WeakSet<object>();

export {
  CONTEXT_GOVERNOR_DETAILS_KEY,
  CONTEXT_GOVERNOR_FLAG,
  CONTEXT_GOVERNOR_METRICS_ENTRY,
  CONTEXT_GOVERNOR_PREVIEW_BYTES,
  CONTEXT_GOVERNOR_PREVIEW_FLAG,
  contextGovernorPreviewBytes,
  eligibleGovernorResult,
  emptyGovernorCounters,
  governContextMessages,
  markGovernorResult,
  parseGovernorMarker,
  renderGovernedPreview,
} from './context-governor';
export { collectGarbage } from './gc';
export {
  normalizeReadSelection,
  processReadSnapshot,
  readSnapshotDigest,
  readSnapshotId,
  reconstructReadSnapshots,
  SNAPSHOT_DETAILS_KEY,
  SNAPSHOT_READS_FLAG,
} from './snapshot-reads';
export {
  putArtifact,
  recoverArtifactFromEntries,
  restoreArtifacts,
  revokeArtifact,
  validateMetadata,
} from './storage';
export type {
  ArtifactMetadata,
  ContentClass,
  ProducerClass,
  PutArtifactInput,
  ResolvedArtifact,
} from './types';
export { MAX_ARTIFACT_BYTES } from './types';

/** Public producer surface. Allowlists block explicit protected labels, but cannot
 * determine what bytes mean. Every producer must still enforce protected-data policy. */
export const artifactProducer = {
  put: putArtifact,
  revoke: revokeArtifact,
} as const;

export function mergeToolResultChanges<
  S extends Record<string, unknown>,
  G extends Record<string, unknown>,
>(
  snapshot: S | undefined,
  governed: G | undefined,
): S | G | (S & G) | undefined {
  if (!governed) return snapshot;
  return snapshot ? { ...snapshot, ...governed } : governed;
}

/** Public read boundary for consumers of artifact-backed session entries. */
export const artifactConsumer = {
  recoverFromEntries: recoverArtifactFromEntries,
} as const;

export default function artifacts(pi: ExtensionAPI): void {
  if (registered.has(pi)) return;
  registered.add(pi);

  pi.on('session_start', async (_event, ctx) => {
    await restoreArtifacts(ctx);
  });
  pi.on('session_tree', async (_event, ctx) => {
    await restoreArtifacts(ctx);
  });
  const snapshotResult = registerSnapshotReads(pi, {
    registerToolResult: false,
  });
  const governResult = registerContextGovernor(pi, {
    registerToolResult: false,
  });
  // Encode the security-sensitive transform order in one composed hook: exact
  // read snapshot publication must precede governor inspection.
  pi.on('tool_result', async (event, ctx) => {
    const snapshot = await snapshotResult(event, ctx);
    const current = snapshot ? { ...event, ...snapshot } : event;
    const governed = await governResult(current, ctx);
    return mergeToolResultChanges(snapshot, governed);
  });

  pi.registerCommand('artifact-revoke', {
    description:
      'Revoke exactly one artifact handle. Recovery bytes remain in append-only session JSONL and exports.',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const handle = parts[0];
      if (!handle) {
        ctx.ui.notify('Usage: /artifact-revoke <handle>', 'error');
        return;
      }
      if (parts.length !== 1) {
        ctx.ui.notify('Usage: /artifact-revoke <handle>', 'error');
        return;
      }
      const confirmed =
        ctx.mode !== 'tui' ||
        (await ctx.ui.confirm(
          'Revoke artifact handle?',
          `The handle ${handle} will become unusable. Recovery bytes remain in session JSONL and standard exports. Continue?`,
        ));
      if (!confirmed) {
        ctx.ui.notify('Artifact revocation cancelled.', 'info');
        return;
      }
      const revoked = await revokeArtifact(pi, ctx, handle);
      ctx.ui.notify(
        revoked
          ? `Revoked artifact ${handle}; session recovery bytes were retained.`
          : `No live artifact found for ${handle}.`,
        revoked ? 'warning' : 'info',
      );
    },
  });

  pi.registerCommand('artifact-gc', {
    description:
      'Run conservative artifact garbage collection now (never scheduled automatically).',
    handler: async (_args, ctx) => {
      const result = await collectGarbage();
      ctx.ui.notify(
        result.aborted
          ? 'Artifact GC aborted: session state was unreadable; nothing was deleted.'
          : `Artifact GC complete: deleted ${result.deleted}, retained ${result.retained}.`,
        result.aborted ? 'error' : 'info',
      );
    },
  });

  pi.registerTool({
    name: 'artifact_retrieve',
    label: 'Retrieve Artifact',
    description:
      'Retrieve exact stored artifact data with bounded selectors and explicit source/returned/remainder byte accounting; it never summarizes.',
    promptSnippet: 'Retrieve bounded exact data from an artifact handle',
    parameters: Type.Object({
      handle: Type.String({ pattern: '^art_[A-Za-z0-9_-]{22}$' }),
      mode: Type.Union(RETRIEVAL_MODES.map((mode) => Type.Literal(mode))),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 16 * 1024 * 1024 }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 * 1024 })),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
      heading: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      pointer: Type.Optional(Type.String({ maxLength: 2048 })),
      field: Type.Optional(Type.String({ maxLength: 1024 })),
      beforeLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
      afterLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await retrieveArtifact(ctx, params as RetrievalRequest);
        return {
          content: [
            { type: 'text' as const, text: renderRetrievalResult(result) },
          ],
          details: result,
        };
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
