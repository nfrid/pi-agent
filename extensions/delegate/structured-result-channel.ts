import { ensureDelegateLifecycle, setDelegateLifecycle } from './lifecycle';
import { validateStructuredResult } from './structured-result-project';
import {
  type NormalizedDelegateResultSpec,
  STRUCTURED_RESULT_CAPS,
  type StructuredArtifacts,
  type StructuredValidationResult,
} from './structured-result-schema';
import type { DelegatedRun, DelegateStructuredResult } from './types';

interface StructuredAttempt {
  detailsPresent: boolean;
  details?: unknown;
  toolError: boolean;
}

interface StructuredChannel {
  calls: number;
  /** Only the bounded prefix is retained; later calls cannot extend retries. */
  attempts: StructuredAttempt[];
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
    attempts: [],
  };
  channel.calls++;
  structuredChannelRuns.add(run);
  if (channel.attempts.length < STRUCTURED_RESULT_CAPS.maxAttempts) {
    const detailsPresent =
      result !== null &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      Object.hasOwn(result, 'details');
    channel.attempts.push({
      detailsPresent,
      details: detailsPresent
        ? (result as { details?: unknown }).details
        : undefined,
      toolError: isError,
    });
  }
  // A later attempt may supersede a previously cached failed settlement.
  settlements.delete(run);
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

function attemptValidation(
  spec: NormalizedDelegateResultSpec,
  attempt: StructuredAttempt,
): StructuredValidationResult {
  const errors: string[] = [];
  if (attempt.toolError)
    errors.push('/: delegate_result tool execution failed');
  if (!attempt.detailsPresent)
    errors.push('/: delegate_result result details are missing or malformed');
  if (errors.length) return { valid: false, errors };
  return validateStructuredResult(spec, attempt.details);
}

function channelError(
  spec: NormalizedDelegateResultSpec,
  channel: StructuredChannel | undefined,
): string[] {
  if (!channel) return ['/: delegate_result channel is missing'];
  if (channel.calls > STRUCTURED_RESULT_CAPS.maxAttempts)
    return [
      `/: delegate_result channel exceeded the ${STRUCTURED_RESULT_CAPS.maxAttempts}-attempt limit without a valid result`,
    ];
  const lastAttempt = channel.attempts.at(-1);
  if (!lastAttempt)
    return ['/: delegate_result channel did not produce an attempt'];
  return attemptValidation(spec, lastAttempt).errors;
}

/** Settlement is idempotent once the channel stops; a new attempt invalidates a cached result. */
export function settleDelegateResult(
  run: DelegatedRun,
  spec = getDelegateResultSpec(run),
): StructuredValidationResult | undefined {
  if (!spec) return undefined;
  const existing = settlements.get(run);
  if (existing) return existing;
  const channel = channels.get(run);
  let validation: StructuredValidationResult;
  let lastFailure: StructuredValidationResult | undefined;
  let lastValid: StructuredValidationResult | undefined;
  for (const attempt of channel?.attempts ?? []) {
    const attemptResult = attemptValidation(spec, attempt);
    if (attemptResult.valid) lastValid = attemptResult;
    else lastFailure = attemptResult;
  }
  if (lastValid) validation = lastValid;
  else {
    const errors = channelError(spec, channel);
    validation = {
      valid: false,
      errors: errors.length ? errors : (lastFailure?.errors ?? []),
    };
  }
  settlements.set(run, validation);
  // Copy only the validated settlement into the enumerable human-facing run.
  // Invalid attempts intentionally have no value field.
  run.structuredResult = {
    valid: validation.valid,
    ...(validation.valid ? { value: validation.value } : {}),
    errors: [...validation.errors],
  };
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

/** Read the owner-facing capture, including values restored from persisted details. */
export function getUserVisibleStructuredResult(
  run: DelegatedRun,
): DelegateStructuredResult | undefined {
  return settlements.get(run) ?? run.structuredResult;
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
