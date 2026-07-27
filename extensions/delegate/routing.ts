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
Take the first route whose "use for" covers the task, not the strongest route that could do it. relativeCost orders the ladder and says nothing about quality. Fresh tasks need an exact route key; continuations reuse their persisted route when omitted.

Climb a rung when the task spans more than one subsystem, when it states no criteria for what to check or what "done" means, or when the question is "is this right" rather than "does this specific property hold". If a route returns a result you cannot act on, retry a rung up rather than re-prompting the same one.

A route persists across every continuation, so one choice usually governs several turns. When a task turns out harder than it looked, switch route on the continuation instead of pushing the current one past what it handles.

A task that states its finish line — the acceptance criteria, or the command that decides done — is safe on a cheap route, because the result is verifiable. Without one, deciding what done means is judgement work and needs a stronger route.

Catalog, cheapest first:
${catalog.length > 0 ? catalog.join('\n') : '- (none)'}
</delegate_routing>`;
}

export function formatDelegateRoutingPrompt(cwd: string): string {
  return formatDelegateRoutingConfig(loadDelegateConfig(cwd));
}
