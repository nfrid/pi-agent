import {
  type DelegateConfig,
  describeDelegateRouting,
  loadDelegateConfig,
} from './config';

// Text content only, never attribute values: quotes and apostrophes need no
// escaping here, and escaping them makes the prose the model reads harder.
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function compactPromptText(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

/** Human route-selection policy paired with the generated route catalog. */
export const DELEGATE_ROUTING_POLICY =
  'Choose the cheapest route whose stated `useFor` fits and whose `avoid` does not apply. Explicit criteria may justify a cheaper route within that fit; they do not override route exclusions. Continuations reuse their persisted route unless explicitly overridden.';

export function formatDelegateRoutingConfig(config: DelegateConfig): string {
  const policy = DELEGATE_ROUTING_POLICY;
  const guidance = config.routingGuidance
    ? `\n\n${escapeXml(compactPromptText(config.routingGuidance))}`
    : '';
  if (config.error)
    return `<delegate_routing>\n${policy}${guidance}\n\nUnavailable: ${escapeXml(config.error)}\n</delegate_routing>`;
  const catalog = describeDelegateRouting(config).map(
    (route) =>
      `- ${escapeXml(route.route)}: model=${escapeXml(route.model)}; thinking=${route.thinking}; relativeCost=${route.relativeCost}\n    useFor: ${escapeXml(compactPromptText(route.useFor))}\n    avoid: ${escapeXml(compactPromptText(route.avoid))}`,
  );
  return `<delegate_routing>
${policy}${guidance}

Catalog, cheapest first (dynamic). relativeCost is benchmark-relative total task cost, not a token-price ratio or quality rank:
${catalog.length > 0 ? catalog.join('\n') : '- (none)'}
</delegate_routing>`;
}

export function formatDelegateRoutingPrompt(
  cwd: string,
  config?: DelegateConfig,
): string {
  return formatDelegateRoutingConfig(config ?? loadDelegateConfig(cwd));
}
