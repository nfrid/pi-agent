import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const EXIT_BUDGET_EXCEEDED = 125;

export default function budgetGuard(pi: ExtensionAPI): void {
  const raw = process.env.PI_DELEGATE_MAX_MODEL_TURNS;
  if (raw === undefined) return;
  const maxTurns = Number.parseInt(raw, 10);
  if (!Number.isInteger(maxTurns) || maxTurns < 0) {
    process.stderr.write('Invalid delegated model-turn budget.\n');
    process.exit(EXIT_BUDGET_EXCEEDED);
  }
  let providerRequestsStarted = 0;
  pi.on('before_provider_request', (event) => {
    // This hook covers the initial request as well as continuation/compaction
    // loops. Provider SDK retries are disabled separately by the runner.
    if (providerRequestsStarted >= maxTurns) {
      process.stderr.write(
        `Delegated model-turn budget ${maxTurns} reached.\n`,
      );
      process.exit(EXIT_BUDGET_EXCEEDED);
    }
    providerRequestsStarted++;
    return event.payload;
  });
}
