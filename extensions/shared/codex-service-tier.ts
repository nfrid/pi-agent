import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

export const CODEX_PROVIDER = 'openai-codex';
export const CODEX_SERVICE_TIER_ENTRY = 'codex-service-tier';
export const CODEX_SERVICE_TIER_CHANGED = 'codex-service-tier:changed';

export type CodexServiceTier = 'fast' | 'ultrafast';

const tiers = new WeakMap<object, CodexServiceTier | undefined>();

export function parseCodexServiceTier(
  value: unknown,
): CodexServiceTier | undefined {
  return value === 'fast' || value === 'ultrafast' ? value : undefined;
}

export function codexServiceTier(
  ctx: ExtensionContext,
): CodexServiceTier | undefined {
  return tiers.get(ctx.sessionManager);
}

export function restoreCodexServiceTier(ctx: ExtensionContext): void {
  let tier: CodexServiceTier | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type !== 'custom' ||
      entry.customType !== CODEX_SERVICE_TIER_ENTRY
    )
      continue;
    const value = (entry.data as { tier?: unknown } | undefined)?.tier;
    tier = parseCodexServiceTier(value);
  }
  tiers.set(ctx.sessionManager, tier);
}

export function setCodexServiceTier(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  tier: CodexServiceTier | undefined,
): void {
  if (codexServiceTier(ctx) === tier) return;
  tiers.set(ctx.sessionManager, tier);
  pi.appendEntry(CODEX_SERVICE_TIER_ENTRY, { tier: tier ?? null });
  pi.events.emit(CODEX_SERVICE_TIER_CHANGED, { tier, ctx });
}

export function codexProviderServiceTier(
  tier: CodexServiceTier,
): 'priority' | 'ultrafast' {
  return tier === 'fast' ? 'priority' : 'ultrafast';
}
