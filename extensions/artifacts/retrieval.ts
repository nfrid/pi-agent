import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  dispatchRetrievalMode,
  type RetrievalMode,
  type RetrievalRequest,
} from './retrieval-modes';
import { resolveArtifact } from './storage';
import { MAX_RESULT_BYTES } from './types';

export { RETRIEVAL_MODES } from './retrieval-modes';
export type { RetrievalMode, RetrievalRequest };

export async function retrieveArtifact(
  ctx: Pick<ExtensionContext, 'sessionManager'>,
  request: RetrievalRequest,
  root?: string,
): Promise<Record<string, unknown>> {
  const artifact = await resolveArtifact(ctx, request.handle, root);
  if (!artifact) throw new Error('Artifact handle not found in this session');
  return dispatchRetrievalMode(artifact, request);
}

export function renderRetrievalResult(result: Record<string, unknown>): string {
  const rendered = JSON.stringify(result);
  if (Buffer.byteLength(rendered) > MAX_RESULT_BYTES)
    throw new Error('Internal result ceiling exceeded');
  return rendered;
}
