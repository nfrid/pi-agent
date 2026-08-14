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
  'Choose the cheapest route whose stated `use for` fits the task. Use stronger reasoning for ambiguous, cross-cutting, or consequential work; use a cheaper route when the objective and finish check are bounded. Continuations reuse their persisted route unless explicitly overridden.';

export function formatDelegateRoutingConfig(config: DelegateConfig): string {
  const policy = DELEGATE_ROUTING_POLICY;
  if (config.error)
    return `<delegate_routing>\n${policy}\n\nUnavailable: ${escapeXml(config.error)}\n</delegate_routing>`;
  const catalog = describeDelegateRouting(config).map(
    (route) =>
      `- ${escapeXml(route.route)}: model=${escapeXml(route.model)}; thinking=${route.thinking}; relativeCost=${route.relativeCost}\n    use for: ${escapeXml(compactPromptText(route.useFor))}\n    avoid: ${escapeXml(compactPromptText(route.avoid))}`,
  );
  return `<delegate_routing>
${policy}

Catalog, cheapest first (dynamic):
${catalog.length > 0 ? catalog.join('\n') : '- (none)'}
</delegate_routing>`;
}

export function formatDelegateRoutingPrompt(
  cwd: string,
  config?: DelegateConfig,
): string {
  return formatDelegateRoutingConfig(config ?? loadDelegateConfig(cwd));
}
