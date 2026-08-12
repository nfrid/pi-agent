import {
  compact as compactSession,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';
import { beginCancellableCompaction } from './compaction-control';

type CompactSession = typeof compactSession;
type BeforeCompactResult = {
  cancel?: boolean;
  compaction?: Awaited<ReturnType<CompactSession>>;
};

export async function compactWithDashboardCancellation(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  runCompaction: CompactSession = compactSession,
): Promise<BeforeCompactResult> {
  const model = ctx.model;
  if (!model) throw new Error('No model is selected for context compaction.');
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const headers = auth.headers
    ? Object.fromEntries(
        Object.entries(auth.headers).filter(
          (entry): entry is [string, string] => entry[1] !== null,
        ),
      )
    : undefined;
  const operation = beginCancellableCompaction(event.signal);
  try {
    const compaction = await runCompaction(
      event.preparation,
      model,
      auth.apiKey,
      headers,
      event.customInstructions,
      operation.signal,
      ctx.thinkingLevel,
      undefined,
      auth.env,
    );
    return { compaction };
  } catch (error) {
    if (operation.wasCancelled()) return { cancel: true };
    throw error;
  } finally {
    operation.finish();
  }
}
