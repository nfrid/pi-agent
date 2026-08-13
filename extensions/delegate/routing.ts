import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  type DelegateConfig,
  describeDelegateRouting,
  loadDelegateConfig,
} from './config';

const ROUTING_POLICY = readFileSync(
  path.resolve(__dirname, '../../instructions/delegate/routing.md'),
  'utf8',
).trim();

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

export function formatDelegateRoutingConfig(config: DelegateConfig): string {
  if (config.error)
    return `<delegate_routing>\nUnavailable: ${escapeXml(config.error)}\n</delegate_routing>`;
  const catalog = describeDelegateRouting(config).map(
    (route) =>
      `- ${escapeXml(route.route)}: model=${escapeXml(route.model)}; thinking=${route.thinking}; relativeCost=${route.relativeCost}\n    use for: ${escapeXml(compactPromptText(route.useFor))}\n    avoid: ${escapeXml(compactPromptText(route.avoid))}`,
  );
  return `<delegate_routing>
${ROUTING_POLICY}

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
