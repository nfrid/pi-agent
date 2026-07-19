import {
  type DelegateConfig,
  describeDelegateRouting,
  loadDelegateConfig,
} from './config';

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function compactPromptText(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

export function formatDelegateRoutingConfig(config: DelegateConfig): string {
  if (config.error)
    return `<delegate_routing>\nUnavailable: ${escapeXml(config.error)}\n</delegate_routing>`;
  const routing = describeDelegateRouting(config);
  const catalog = routing.catalog.map((route) => {
    const description = compactPromptText(route.description);
    return `- ${escapeXml(route.route)}: model=${escapeXml(route.model)}; thinking=${route.thinking}; relativeCost=${route.relativeCost}; relativeIntelligence=${route.relativeIntelligence}${route.allowed ? '' : '; unavailable-above-ceiling'}${description ? `; ${escapeXml(description)}` : ''}`;
  });
  return `<delegate_routing>\nPick the cheapest catalog route that is smart enough for the task. Route descriptions are hints, not roles. Fresh tasks need an exact route key; continuations reuse their persisted route when omitted. maxRelativeCost=${routing.maxRelativeCost}.\nCatalog routes:\n${catalog.length > 0 ? catalog.join('\n') : '- (none)'}\n</delegate_routing>`;
}

export function formatDelegateRoutingPrompt(cwd: string): string {
  return formatDelegateRoutingConfig(loadDelegateConfig(cwd));
}
