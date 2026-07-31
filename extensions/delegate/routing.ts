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

export function formatDelegateRoutingConfig(config: DelegateConfig): string {
  if (config.error)
    return `<delegate_routing>\nUnavailable: ${escapeXml(config.error)}\n</delegate_routing>`;
  const catalog = describeDelegateRouting(config).map(
    (route) =>
      `- ${escapeXml(route.route)}: model=${escapeXml(route.model)}; thinking=${route.thinking}; relativeCost=${route.relativeCost}\n    use for: ${escapeXml(compactPromptText(route.useFor))}\n    avoid: ${escapeXml(compactPromptText(route.avoid))}`,
  );
  return `<delegate_routing>
Choose the task's service class before choosing an effort level: value/background work, interactive/deadline work with an explicit wall-clock objective, or maintainer judgement. Match that objective to the route descriptions, then take the cheapest route in that class whose "use for" covers the task. Fresh tasks need an exact route key; continuations reuse their persisted route when omitted.

Escalate effort within the chosen class when the task spans more subsystems or needs more exploration and verification. Do not cross service classes merely because one route was insufficient: switch only when the objective changes. Unclear criteria or "is this right" calls belong to the judgement class, not a higher effort in the value or deadline class.

A route persists across every continuation, so one choice usually governs several turns. If a result is unusable, continue on a higher effort in the same class; change class only when the task objective changed.

A task that states its finish line — the acceptance criteria, or the command that decides done — is safe on a cheaper value route because the result is verifiable. Background parallel work normally favors the value class; a foreground child that blocks the parent may justify the deadline class when the task states a wall-clock objective.

relativeCost is a usage-drain prior, not a quality score or a global escalation ladder. The catalog is displayed cheapest first only to expose that cost.

Catalog, cheapest first:
${catalog.length > 0 ? catalog.join('\n') : '- (none)'}
</delegate_routing>`;
}

export function formatDelegateRoutingPrompt(
  cwd: string,
  config?: DelegateConfig,
): string {
  return formatDelegateRoutingConfig(config ?? loadDelegateConfig(cwd));
}
