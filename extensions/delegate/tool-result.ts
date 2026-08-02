import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { artifactProducer } from '../shared/artifacts';
import { buildParentHandoffResult } from './output';
import { throwIfAllRunsFailed } from './param-errors';
import {
  type DelegateDetails,
  type DelegatedRun,
  getExactFinalAssistantText,
} from './types';

export function makeDetails(
  mode: DelegateDetails['mode'],
  runs: DelegatedRun[],
): DelegateDetails {
  return { mode, runs };
}

export async function buildArtifactBackedHandoff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runs: DelegatedRun[],
  put = artifactProducer.put,
): Promise<string> {
  let result = buildParentHandoffResult(runs);
  const failedRuns = new Set<DelegatedRun>();
  for (let pass = 0; pass < runs.length; pass++) {
    let changed = false;
    for (const run of runs) {
      if (
        run.artifact ||
        failedRuns.has(run) ||
        !result.omittedOriginalReports.has(run)
      )
        continue;
      const exact = getExactFinalAssistantText(run.messages);
      if (!exact) continue;
      try {
        run.artifact = await put(pi, ctx, {
          bytes: exact,
          producer: 'delegate',
          contentClass: 'delegate-output',
          mediaType: 'text/plain; charset=utf-8',
          creationSource: 'delegate.result',
        });
        changed = true;
      } catch {
        run.warnings = [
          ...(run.warnings ?? []),
          'Exact output artifact unavailable; child session remains authoritative.',
        ];
        failedRuns.add(run);
        changed = true;
      }
    }
    if (!changed) break;
    result = buildParentHandoffResult(runs);
  }
  return result.text;
}

export async function delegateToolResult(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  mode: DelegateDetails['mode'],
  runs: DelegatedRun[],
) {
  const handoff = await buildArtifactBackedHandoff(pi, ctx, runs);
  throwIfAllRunsFailed(runs, handoff);
  return {
    content: [{ type: 'text' as const, text: handoff }],
    details: makeDetails(mode, runs),
  };
}
