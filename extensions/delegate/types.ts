import type { Message } from '@earendil-works/pi-ai';
import type { ArtifactMetadata } from '../artifacts';

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
  relativeIntelligence: number;
  description?: string;
}

export interface DelegateRouteState {
  route: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  relativeCost: number;
  relativeIntelligence: number;
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

export interface DelegateIsolationState {
  id: string;
  backend: 'macos-sandbox-exec';
  repositoryRoot: string;
  worktreePath: string;
  workingDirectory: string;
  baseHead: string;
  dependencyMode: 'link' | 'isolated';
  runOutcome?: 'success' | 'error' | 'aborted' | 'timed-out' | 'unknown';
  validation?: {
    status: 'not-run' | 'passed' | 'failed';
    script?: string;
    scriptSha256?: string;
    exitCode?: number;
    outputSha256?: string;
    validatedAt?: string;
    reason?: string;
  };
  status:
    | 'prepared'
    | 'running'
    | 'ran'
    | 'patch-ready'
    | 'no-changes'
    | 'applied'
    | 'discarded'
    | 'conflicted'
    | 'failed';
  patch?: {
    handle?: string;
    sha256: string;
    size: number;
    changedPaths: string[];
    diffCheckPassed: boolean;
    requiresIsolatedDependencyValidation: boolean;
    unsafeReason?: string;
  };
}

export interface DelegateRunMetadata {
  cwd?: string;
  context?: DelegateContext;
  contextNote?: string;
  allowWrites?: boolean;
  writeRequested?: boolean;
  readOnlyBoundary?:
    | 'macos-sandbox-exec'
    | 'isolated-controlled-tools'
    | 'controlled-tools';
  scope?: string[];
  continuation?: string;
  warnings?: string[];
  isolation?: DelegateIsolationState;
  /** Exact final assistant output, stored only when the parent handoff omits it. */
  artifact?: ArtifactMetadata;
}

export interface DelegatedRun extends DelegateRunMetadata {
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

export function getExactFinalAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    if (text.trim()) return text;
  }
  return '';
}

export function getFinalAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text' && part.text.trim())
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}
