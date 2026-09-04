import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  CODEX_PROVIDER,
  type CodexServiceTier,
  codexProviderServiceTier,
  codexServiceTier,
  parseCodexServiceTier,
  restoreCodexServiceTier,
  setCodexServiceTier,
} from '../shared/codex-service-tier';

const FLAG = 'service-tier';
const CHOICES = ['normal', 'fast', 'ultrafast'] as const;

function choiceTier(value: string | undefined): CodexServiceTier | undefined {
  if (value === 'normal') return undefined;
  return parseCodexServiceTier(value);
}

export default function codexServiceTierExtension(pi: ExtensionAPI): void {
  pi.registerFlag(FLAG, {
    description: 'Codex request speed: normal, fast, or ultrafast',
    type: 'string',
  });

  pi.on('session_start', (_event, ctx) => {
    restoreCodexServiceTier(ctx);
    const flag = pi.getFlag(FLAG);
    if (flag === undefined) return;
    if (flag === 'normal') {
      setCodexServiceTier(pi, ctx, undefined);
      return;
    }
    const tier = parseCodexServiceTier(flag);
    if (tier) setCodexServiceTier(pi, ctx, tier);
    else ctx.ui.notify(`Invalid --${FLAG}: ${String(flag)}`, 'warning');
  });

  pi.registerCommand('service-tier', {
    description: 'Set Codex request speed',
    getArgumentCompletions: (prefix) =>
      CHOICES.filter((choice) => choice.startsWith(prefix)).map((choice) => ({
        value: choice,
        label: choice,
      })),
    handler: async (args, ctx) => {
      if (ctx.model?.provider !== CODEX_PROVIDER) {
        ctx.ui.notify(
          'Service tier is available only for Codex models.',
          'warning',
        );
        return;
      }
      const requested = args.trim().toLowerCase();
      const choice =
        requested || (await ctx.ui.select('Codex speed', [...CHOICES]));
      if (!choice || !CHOICES.includes(choice as (typeof CHOICES)[number])) {
        if (requested)
          ctx.ui.notify('Use normal, fast, or ultrafast.', 'warning');
        return;
      }
      setCodexServiceTier(pi, ctx, choiceTier(choice));
      ctx.ui.notify(`Codex speed: ${choice}`, 'info');
    },
  });

  pi.on('model_select', (event, ctx) => {
    if (event.model.provider !== CODEX_PROVIDER)
      setCodexServiceTier(pi, ctx, undefined);
  });

  pi.on('before_provider_request', (event, ctx) => {
    if (
      ctx.model?.provider !== CODEX_PROVIDER ||
      !event.payload ||
      typeof event.payload !== 'object' ||
      Array.isArray(event.payload)
    )
      return;
    const { service_tier: _serviceTier, ...payload } = event.payload as Record<
      string,
      unknown
    >;
    const tier = codexServiceTier(ctx);
    return tier
      ? { ...payload, service_tier: codexProviderServiceTier(tier) }
      : payload;
  });
}

export type { CodexServiceTier } from '../shared/codex-service-tier';
