import type { Message } from '@earendil-works/pi-ai';
import type { ArtifactMetadata } from '../shared/artifacts';
import type { WorktreeSummary } from './worktree/model';

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextTokens: number;
  cost: number;
  turns: number;
}

export interface DelegatedActivity {
  id?: string;
  type: 'thinking' | 'tool';
  label: string;
  status: 'running' | 'completed' | 'error';
  latestText?: string;
}

export type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface DelegateModelCatalogEntry {
  provider?: string;
  model: string;
  thinking: ThinkingLevel;
  relativeCost: number;
  /** Concrete task shapes this route handles. */
  useFor: string;
  /** Concrete task shapes to send elsewhere. */
  avoid: string;
}

export interface DelegateRouteState {
  route: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  relativeCost: number;
  warning?: string;
}

export type DelegateContext = 'branch' | 'fresh' | 'continuation';
export type DelegateRunState =
  | 'queued'
  | 'running'
  | 'success'
  | 'error'
  | 'aborted'
  | 'timed-out';

export type DelegateProgressUpdate = Parameters<
  NonNullable<
    Parameters<
      typeof import('./task-lifecycle').runPreparedDelegateTask
    >[1]['onUpdate']
  >
>[0];

export interface DelegateRunMetadata {
  name?: string;
  cwd?: string;
  context?: DelegateContext;
  contextNote?: string;
  allowWrites?: boolean;
  writeRequested?: boolean;
  scope?: string[];
  continuation?: string;
  backgroundJobId?: string;
  warnings?: string[];
  /** The branch holding this run's work, when it ran in its own worktree. */
  worktree?: WorktreeSummary;
  /** Exact final assistant output, stored only when the parent handoff omits it. */
  artifact?: ArtifactMetadata;
}

export interface DelegatedRun extends DelegateRunMetadata {
  name: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  routing?: DelegateRouteState;
  activities: DelegatedActivity[];
  state?: DelegateRunState;
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface DelegateDetails {
  mode: 'single' | 'parallel';
  runs: DelegatedRun[];
}

export function emptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    contextTokens: 0,
    cost: 0,
    turns: 0,
  };
}

export function createRun(
  task: string,
  routing?: DelegateRouteState,
  metadata: DelegateRunMetadata = {},
): DelegatedRun {
  return {
    task,
    exitCode: -1,
    messages: [],
    stderr: '',
    usage: emptyUsage(),
    routing,
    activities: [],
    state: 'queued',
    queuedAt: Date.now(),
    ...metadata,
    name: metadata.name?.trim() || 'Subagent',
  };
}

export function getRunState(run: DelegatedRun): DelegateRunState {
  if (run.state) return run.state;
  if (run.exitCode === -1) return 'running';
  if (run.stopReason === 'aborted') return 'aborted';
  if (run.exitCode === 124) return 'timed-out';
  return isRunError(run) ? 'error' : 'success';
}

export function isRunError(run: DelegatedRun): boolean {
  if (run.exitCode === -1) return false;
  if (run.stopReason === 'error' || run.stopReason === 'aborted') return true;
  return run.exitCode !== 0 || !getFinalAssistantText(run.messages).trim();
}

/**
 * A worktree records a prior terminal run so its partial branch remains
 * reviewable. A successful continuation is a new attempt, not that failure.
 */
export function continuationRecoveryNote(
  run: DelegatedRun,
): string | undefined {
  if (
    run.context !== 'continuation' ||
    getRunState(run) !== 'success' ||
    !run.worktree
  )
    return undefined;

  const outcome = run.worktree.runOutcome;
  if (outcome === 'timed-out')
    return 'Earlier attempt timed out; this continuation completed on the same branch.';
  if (outcome === 'aborted')
    return 'Earlier attempt was aborted; this continuation completed on the same branch.';
  if (outcome === 'error')
    return 'Earlier attempt ended with error; this continuation completed on the same branch.';

  // Records written before runOutcome existed retain only this exact prose.
  const error = run.worktree.error;
  if (!error) return undefined;
  if (/^The delegate run timed out;/.test(error))
    return 'Earlier attempt timed out; this continuation completed on the same branch.';
  if (/^The delegate run ended with aborted;/.test(error))
    return 'Earlier attempt was aborted; this continuation completed on the same branch.';
  if (/^The delegate run ended with error;/.test(error))
    return 'Earlier attempt ended with error; this continuation completed on the same branch.';
  return undefined;
}

export function getFinalAssistantText(
  messages: Message[],
  options?: { exact?: boolean },
): string {
  const exact = options?.exact ?? false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text' && (exact || part.text.trim()))
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    if (exact) {
      if (text.trim()) return text;
    } else if (text.trim()) {
      return text.trim();
    }
  }
  return '';
}

export function getExactFinalAssistantText(messages: Message[]): string {
  return getFinalAssistantText(messages, { exact: true });
}
