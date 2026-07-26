import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  collectGarbage,
  RETRIEVAL_MODES,
  type RetrievalRequest,
  renderRetrievalResult,
  restoreArtifacts,
  retrieveArtifact,
} from '../shared/artifacts';
import { defineExtension } from '../shared/runtime/extension';

/**
 * Host registration for artifact storage. The library itself lives in
 * `shared/artifacts` because `web` and `delegate` produce artifacts too.
 */
export default defineExtension('artifacts', (pi: ExtensionAPI) => {
  // A resumed, forked, or imported session has session entries but no files;
  // both events rebuild what the handles point at.
  pi.on('session_start', async (_event, ctx) => {
    await restoreArtifacts(ctx);
  });
  pi.on('session_tree', async (_event, ctx) => {
    await restoreArtifacts(ctx);
  });

  pi.registerCommand('artifact-gc', {
    description: 'Delete stored artifacts belonging to sessions that are gone.',
    handler: async (_args, ctx) => {
      const result = await collectGarbage();
      ctx.ui.notify(
        result.aborted
          ? 'Artifact GC aborted: session state was unreadable, so nothing was deleted.'
          : `Artifact GC complete: deleted ${result.deleted}, kept ${result.retained}.`,
        result.aborted ? 'error' : 'info',
      );
    },
  });

  pi.registerTool({
    name: 'artifact_retrieve',
    label: 'Retrieve Artifact',
    description:
      'Read exact bytes out of an artifact handle. Modes: metadata (size, line count), lines (offset/limit), search (query with beforeLines/afterLines context), json (JSON pointer), bytes (base64 slice for binary).',
    promptSnippet: 'Retrieve bounded exact data from an artifact handle',
    parameters: Type.Object({
      handle: Type.String({ pattern: '^art_[A-Za-z0-9_-]{22}$' }),
      mode: Type.Union(RETRIEVAL_MODES.map((mode) => Type.Literal(mode))),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: 16 * 1024 * 1024,
          description: 'Line number for lines, byte offset for bytes. 0-based.',
        }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 * 1024 })),
      query: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 1024,
          description: 'Case-insensitive substring to search for.',
        }),
      ),
      pointer: Type.Optional(
        Type.String({ maxLength: 2048, description: 'RFC 6901 JSON pointer.' }),
      ),
      beforeLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
      afterLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await retrieveArtifact(ctx, params as RetrievalRequest);
      return {
        content: [
          { type: 'text' as const, text: renderRetrievalResult(result) },
        ],
        details: result,
      };
    },
  });
});
