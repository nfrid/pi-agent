import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { type CacheFile, writeCacheFile } from '../shared/cache-files';
import {
  getDelegateLifecycle,
  getDelegateLifecycleDiagnostic,
  isDelegateLifecycleDiagnosticPublicationFailed,
  LIFECYCLE_INLINE_DIAGNOSTIC_BYTES,
  markDelegateLifecycleDiagnosticPublicationFailed,
  setDelegateLifecycleDiagnosticFile,
} from './lifecycle';
import { buildParentHandoffResult } from './output';
import { throwIfAllRunsFailed } from './param-errors';
import { serializeDelegateRunForPublic } from './serialize';
import {
  type DelegateDetails,
  type DelegatedRun,
  getExactFinalAssistantText,
} from './types';

export function makeDetails(
  mode: DelegateDetails['mode'],
  runs: DelegatedRun[],
): DelegateDetails {
  return {
    mode,
    runs: runs.map((run) => serializeDelegateRunForPublic(run)),
  };
}

export const EXACT_OUTPUT_FILE_WARNING =
  'Exact output file unavailable; child session remains authoritative.';

type CacheWriter = (
  bytes: Uint8Array | string,
  extension: string,
) => Promise<CacheFile>;

async function publishLifecycleDiagnostic(
  run: DelegatedRun,
  write: CacheWriter,
): Promise<boolean> {
  const lifecycle = getDelegateLifecycle(run);
  const diagnostic = getDelegateLifecycleDiagnostic(run);
  if (
    !lifecycle ||
    !diagnostic ||
    Buffer.byteLength(diagnostic, 'utf8') <=
      LIFECYCLE_INLINE_DIAGNOSTIC_BYTES ||
    lifecycle.diagnosticFile ||
    isDelegateLifecycleDiagnosticPublicationFailed(run)
  )
    return false;
  try {
    const file = await write(diagnostic, '.txt');
    setDelegateLifecycleDiagnosticFile(run, file);
    return true;
  } catch {
    markDelegateLifecycleDiagnosticPublicationFailed(run);
    return true;
  }
}

/** Materialize every exact final report and return the bounded parent handoff. */
export async function buildOutputFileHandoff(
  runs: DelegatedRun[],
  write: CacheWriter = (bytes, extension) => writeCacheFile(bytes, extension),
): Promise<string> {
  let result = buildParentHandoffResult(runs);
  const failedRuns = new Set<DelegatedRun>();
  for (const run of runs) {
    if (await publishLifecycleDiagnostic(run, write))
      result = buildParentHandoffResult(runs);
    if (run.outputFile || failedRuns.has(run)) continue;
    const exact = getExactFinalAssistantText(run.messages);
    if (!exact) continue;
    try {
      run.outputFile = await write(exact, '.md');
      run.warnings = (run.warnings ?? []).filter(
        (warning) => warning !== EXACT_OUTPUT_FILE_WARNING,
      );
    } catch {
      run.warnings = [
        ...(run.warnings ?? []).filter(
          (warning) => warning !== EXACT_OUTPUT_FILE_WARNING,
        ),
        EXACT_OUTPUT_FILE_WARNING,
      ];
      failedRuns.add(run);
    }
    result = buildParentHandoffResult(runs, undefined, {
      inlineFallbackRuns: failedRuns,
    });
  }
  return result.text;
}

export async function delegateToolResult(
  _pi: unknown,
  _ctx: ExtensionContext,
  mode: DelegateDetails['mode'],
  runs: DelegatedRun[],
) {
  const handoff = await buildOutputFileHandoff(runs);
  if (!runs.some((run) => getDelegateLifecycle(run)))
    throwIfAllRunsFailed(runs, handoff);
  return {
    content: [{ type: 'text' as const, text: handoff }],
    details: makeDetails(mode, runs),
  };
}
