import { ensureDelegateLifecycle, setDelegateLifecycle } from './lifecycle';
import { validateStructuredResult } from './structured-result-project';
import type {
  NormalizedDelegateResultSpec,
  StructuredArtifacts,
  StructuredValidationResult,
} from './structured-result-schema';
import type { DelegatedRun } from './types';

interface StructuredChannel {
  calls: number;
  detailsPresent: boolean;
  details?: unknown;
  toolError: boolean;
}

const resultSpecs = new WeakMap<DelegatedRun, NormalizedDelegateResultSpec>();
const channels = new WeakMap<DelegatedRun, StructuredChannel>();
const structuredChannelRuns = new WeakSet<DelegatedRun>();
const settlements = new WeakMap<DelegatedRun, StructuredValidationResult>();
const artifactViews = new WeakMap<DelegatedRun, StructuredArtifacts>();

export function setDelegateResultSpec(
  run: DelegatedRun,
  spec: NormalizedDelegateResultSpec | undefined,
): void {
  if (spec) resultSpecs.set(run, spec);
}

export function getDelegateResultSpec(
  run: DelegatedRun,
): NormalizedDelegateResultSpec | undefined {
  return resultSpecs.get(run);
}

/** Capture only the structured tool's details; never attach them to run data. */
export function captureDelegateResultEvent(
  run: DelegatedRun,
  result: unknown,
  isError: boolean,
): void {
  const previous = channels.get(run);
  const channel: StructuredChannel = previous ?? {
    calls: 0,
    detailsPresent: false,
    toolError: false,
  };
  channel.calls++;
  channel.toolError ||= isError;
  structuredChannelRuns.add(run);
  if (
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    Object.hasOwn(result, 'details')
  ) {
    channel.detailsPresent = true;
    channel.details = (result as { details?: unknown }).details;
  }
  redactDelegateResultTerminalProse(run);
  channels.set(run, channel);
}

export function redactDelegateResultTerminalProse(run: DelegatedRun): void {
  if (!structuredChannelRuns.has(run)) return;
  for (let index = run.messages.length - 1; index >= 0; index--) {
    const message = run.messages[index];
    if (message.role !== 'assistant') continue;
    // The terminating action owns the structured channel. Any prose in that
    // assistant turn is neither part of the contract nor safe to expose next
    // to an artifact-only result.
    run.messages[index] = {
      ...message,
      content: message.content.filter((part) => part.type !== 'text'),
    };
    return;
  }
}

function channelError(channel: StructuredChannel | undefined): string[] {
  if (!channel) return ['/: delegate_result channel is missing'];
  const errors: string[] = [];
  if (channel.calls !== 1)
    errors.push(
      `/: delegate_result channel must be called exactly once (got ${channel.calls})`,
    );
  if (channel.toolError)
    errors.push('/: delegate_result tool execution failed');
  if (!channel.detailsPresent)
    errors.push('/: delegate_result result details are missing or malformed');
  return errors;
}

/** Settlement is deliberately idempotent: a parent validates once, then reuses the result. */
export function settleDelegateResult(
  run: DelegatedRun,
  spec = getDelegateResultSpec(run),
): StructuredValidationResult | undefined {
  if (!spec) return undefined;
  const existing = settlements.get(run);
  if (existing) return existing;
  const channel = channels.get(run);
  const channelErrors = channelError(channel);
  const validation = channelErrors.length
    ? { valid: false, errors: channelErrors }
    : validateStructuredResult(spec, channel?.details);
  settlements.set(run, validation);
  if (!validation.valid) {
    const lifecycle = ensureDelegateLifecycle(run);
    if (!lifecycle || lifecycle.reason === 'unknown')
      setDelegateLifecycle(
        run,
        'child-result-invalid',
        validation.errors.join('; '),
      );
    run.stopReason = 'error';
    const summary = validation.errors.join('; ').slice(0, 900);
    run.errorMessage = `Structured delegate result invalid: ${summary}`;
    if (
      run.state === 'success' ||
      run.state === 'queued' ||
      run.state === 'running'
    )
      run.state = 'error';
  }
  return validation;
}

export function getSettledDelegateResult(
  run: DelegatedRun,
): StructuredValidationResult | undefined {
  return settlements.get(run);
}

export function getDelegateChannelPresent(run: DelegatedRun): boolean {
  return Boolean(channels.get(run));
}

export function setStructuredArtifacts(
  run: DelegatedRun,
  views: Record<string, { handle: string; size: number }>,
): void {
  artifactViews.set(run, { views });
}

export function getStructuredArtifacts(
  run: DelegatedRun,
): StructuredArtifacts | undefined {
  return artifactViews.get(run);
}
