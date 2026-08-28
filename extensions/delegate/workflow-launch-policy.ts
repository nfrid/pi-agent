import type { DelegateJobStartOptions } from './jobs';
import { isCanonicalUuid, MAX_WORKFLOW_DEPENDENCIES } from './workflow-model';

/** The coordinator's schedule shape, kept structural to avoid a policy cycle. */
interface WorkflowScheduleValidationInput {
  logicalId: unknown;
  continuation?: unknown;
  after?: unknown;
  inputs?: unknown;
  prepare?: unknown;
  preparationCleanup?: unknown;
  execute?: unknown;
  mode?: unknown;
  tasks?: unknown;
  route?: unknown;
}

interface PreparedWorkflowLaunch {
  readonly launch: DelegateJobStartOptions;
  readonly discard?: () => void | Promise<void>;
}

const DEFAULT_MAX_WORKFLOW_NAME_LENGTH = 2_000;

/** Keep schedule and prepared-launch checks independent of coordinator state. */
export function validateScheduleInput(
  options: WorkflowScheduleValidationInput,
  maxDependencies = MAX_WORKFLOW_DEPENDENCIES,
): void {
  if (typeof options.logicalId !== 'string')
    throw new Error('Invalid workflow logical ID: expected a string.');
  if (
    options.continuation !== undefined &&
    typeof options.continuation !== 'boolean' &&
    typeof options.continuation !== 'string'
  )
    throw new Error('Invalid workflow continuation reference.');
  if (options.after !== undefined && !Array.isArray(options.after))
    throw new Error('Invalid workflow dependencies: expected an array.');
  if (Array.isArray(options.after) && options.after.length > maxDependencies)
    throw new Error(
      `A workflow attempt may declare at most ${maxDependencies} explicit dependencies.`,
    );
  if (
    Array.isArray(options.after) &&
    options.after.some((reference) => typeof reference !== 'string')
  )
    throw new Error(
      'Invalid workflow dependency: expected a string reference.',
    );
  if (options.inputs !== undefined && !Array.isArray(options.inputs))
    throw new Error('Invalid symbolic workflow inputs: expected an array.');
  if (options.prepare !== undefined && typeof options.prepare !== 'function')
    throw new Error('Invalid lazy workflow launch factory.');
  if (
    options.preparationCleanup !== undefined &&
    typeof options.preparationCleanup !== 'function'
  )
    throw new Error('Invalid workflow preparation cleanup.');
  const lazy = options.prepare !== undefined;
  if (lazy && options.execute !== undefined)
    throw new Error(
      'Static execute options and lazy preparation are mutually exclusive.',
    );
  if (!lazy) {
    if (options.mode !== 'single' && options.mode !== 'parallel')
      throw new Error('Invalid delegate mode.');
    if (
      !Array.isArray(options.tasks) ||
      options.tasks.some((task) => typeof task !== 'string')
    )
      throw new Error('Invalid delegate tasks: expected an array of strings.');
    if (typeof options.execute !== 'function')
      throw new Error('Invalid delegate launch: execute must be a function.');
    if (Array.isArray(options.inputs) && options.inputs.length)
      throw new Error('Symbolic workflow inputs require lazy preparation.');
  }
  if (options.route !== undefined && typeof options.route !== 'string')
    throw new Error('Invalid delegate route.');
}

export function boundedWorkflowName(
  value: unknown,
  fallback = 'Subagent',
  maxLength = DEFAULT_MAX_WORKFLOW_NAME_LENGTH,
): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fallback;
  if (
    [...text].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return fallback;
  return text.slice(0, maxLength);
}

export function validProcessLink(
  sessionId: unknown,
  processJobId: unknown,
): sessionId is string {
  const hasSession = sessionId !== undefined;
  const hasProcessJob = processJobId !== undefined;
  if (hasSession !== hasProcessJob) return false;
  if (!hasSession) return true;
  return (
    boundedSessionId(sessionId) !== undefined && isCanonicalUuid(processJobId)
  );
}

export function boundedSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256)
    return undefined;
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return undefined;
  return value;
}

/** Normalize either supported lazy factory return shape without side effects. */
export function normalizePreparedLaunch(
  value: DelegateJobStartOptions | PreparedWorkflowLaunch,
): PreparedWorkflowLaunch {
  if (
    value &&
    typeof value === 'object' &&
    'launch' in value &&
    value.launch &&
    typeof value.launch === 'object'
  )
    return value as PreparedWorkflowLaunch;
  return { launch: value as DelegateJobStartOptions };
}

/** Validate the adapter-owned portion of a lazy launch result. */
export function validatePreparedLaunch(
  value: unknown,
): asserts value is DelegateJobStartOptions {
  if (!value || typeof value !== 'object')
    throw new Error('Lazy workflow launch factory must return job options.');
  const launch = value as Partial<DelegateJobStartOptions>;
  if (launch.mode !== 'single' && launch.mode !== 'parallel')
    throw new Error('Lazy workflow launch factory returned an invalid mode.');
  if (
    !Array.isArray(launch.tasks) ||
    launch.tasks.some((task) => typeof task !== 'string')
  )
    throw new Error('Lazy workflow launch factory returned invalid tasks.');
  if (typeof launch.execute !== 'function')
    throw new Error(
      'Lazy workflow launch factory returned no execute function.',
    );
}
