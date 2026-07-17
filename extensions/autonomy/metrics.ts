import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type {
  ExtensionAPI,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { delegateStateRoot } from '../delegate/isolation';
import type { SandboxShellResult } from './shell';
import type {
  AutonomyMetrics,
  AutonomyMode,
  EnvelopeDelta,
  LegacyAutonomyMetrics,
  PolicyReasonCode,
} from './types';

export const AUTONOMY_METRICS_ENTRY = 'workflow-autonomy-metrics:v2';
export const LEGACY_AUTONOMY_METRICS_ENTRY = 'workflow-autonomy-metrics:v1';

let cachedMetricsKey: Buffer | undefined;
function metricsKey(): Buffer {
  if (cachedMetricsKey) return cachedMetricsKey;
  const directory = path.join(delegateStateRoot(), 'autonomy-metrics');
  const file = path.join(directory, 'selection-hmac.key');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    cachedMetricsKey = readFileSync(file);
  } catch {
    const generated = randomBytes(32);
    try {
      writeFileSync(file, generated, { flag: 'wx', mode: 0o600 });
      cachedMetricsKey = generated;
    } catch {
      cachedMetricsKey = readFileSync(file);
    }
  }
  return cachedMetricsKey;
}

export function initialMetrics(
  now = Date.now(),
  mode: AutonomyMode = 'observe',
): AutonomyMetrics {
  return {
    version: 2,
    mode,
    startedAt: now,
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    repeatedReads: 0,
    repeatedStatuses: 0,
    delegateCalls: 0,
    delegateInputTokens: 0,
    delegateOutputTokens: 0,
    delegateCostUsd: 0,
    blockedCapabilityAttempts: 0,
    observedCapabilityViolations: 0,
    autoApprovedLeases: 0,
    leasedRepositories: 0,
    leasedPaths: 0,
    interactiveApprovals: 0,
    interactiveDenials: 0,
    sandboxShellInspectCalls: 0,
    sandboxShellValidateCalls: 0,
    sandboxShellEditCalls: 0,
    sandboxShellFailures: 0,
    sandboxShellAppliedEdits: 0,
    sandboxShellRejectedEdits: 0,
    sandboxShellChangedPaths: 0,
    patchConflicts: 0,
    policyDenials: {},
    readSelectionHashes: [],
    statusSelectionHashes: [],
  };
}

export function migrateMetrics(
  value: AutonomyMetrics | LegacyAutonomyMetrics,
  mode: AutonomyMode,
): AutonomyMetrics {
  if (value.version === 2)
    return {
      ...value,
      mode: value.mode === mode ? mode : 'mixed',
      policyDenials: { ...value.policyDenials },
      readSelectionHashes: [...(value.readSelectionHashes ?? [])],
      statusSelectionHashes: [...(value.statusSelectionHashes ?? [])],
    };
  return {
    ...initialMetrics(value.startedAt, mode),
    turns: value.turns,
    toolCalls: value.toolCalls,
    toolErrors: value.toolErrors,
    repeatedReads: value.repeatedReads,
    repeatedStatuses: value.repeatedStatuses,
    delegateCalls: value.delegateCalls,
    delegateInputTokens: value.delegateInputTokens,
    delegateOutputTokens: value.delegateOutputTokens,
    delegateCostUsd: value.delegateCostUsd,
    blockedCapabilityAttempts: value.blockedCapabilityAttempts,
    observedCapabilityViolations: value.observedCapabilityViolations,
    patchConflicts: value.patchConflicts,
    readSelectionHashes: [...(value.readSelectionHashes ?? [])],
    statusSelectionHashes: [...(value.statusSelectionHashes ?? [])],
  };
}

let activeCollector: MetricsCollector | undefined;

export class MetricsCollector {
  readonly values: AutonomyMetrics;
  private readonly seenReads = new Set<string>();
  private readonly seenStatuses = new Set<string>();

  constructor(
    now = Date.now(),
    restored?: AutonomyMetrics | LegacyAutonomyMetrics,
    mode: AutonomyMode = 'observe',
  ) {
    this.values = restored
      ? migrateMetrics(restored, mode)
      : initialMetrics(now, mode);
    for (const hash of this.values.readSelectionHashes)
      this.seenReads.add(hash);
    for (const hash of this.values.statusSelectionHashes)
      this.seenStatuses.add(hash);
    activeCollector = this;
  }

  turn(): void {
    this.values.turns++;
  }

  toolCall(name: string, input: unknown): void {
    this.values.toolCalls++;
    const digest = createHmac('sha256', metricsKey())
      .update(JSON.stringify(input ?? null))
      .digest('hex');
    if (name === 'read') {
      if (this.seenReads.has(digest)) this.values.repeatedReads++;
      this.seenReads.add(digest);
      this.values.readSelectionHashes = [...this.seenReads].slice(-1000);
    }
    if (name === 'repository_navigate') {
      if (this.seenStatuses.has(digest)) this.values.repeatedStatuses++;
      this.seenStatuses.add(digest);
      this.values.statusSelectionHashes = [...this.seenStatuses].slice(-1000);
    }
    if (name === 'delegate') this.values.delegateCalls++;
  }

  toolResult(event: ToolResultEvent): void {
    if (event.isError) this.values.toolErrors++;
    if (event.toolName !== 'delegate' && event.toolName !== 'todo_schedule')
      return;
    const runs = (event.details as { runs?: unknown[] } | undefined)?.runs;
    if (!Array.isArray(runs)) return;
    for (const raw of runs) {
      const usage = (raw as { usage?: Record<string, unknown> })?.usage;
      if (!usage) continue;
      this.values.delegateInputTokens += number(usage.input);
      this.values.delegateOutputTokens += number(usage.output);
      this.values.delegateCostUsd += number(usage.cost);
    }
  }

  policyDecision(code: PolicyReasonCode, blocked: boolean): void {
    this.values.policyDenials[code] =
      (this.values.policyDenials[code] ?? 0) + 1;
    if (blocked) this.values.blockedCapabilityAttempts++;
    else this.values.observedCapabilityViolations++;
  }

  autoLease(delta: EnvelopeDelta): void {
    this.values.autoApprovedLeases++;
    this.values.leasedRepositories += delta.addedRepositories.length;
    this.values.leasedPaths += delta.expandedPaths.length;
  }

  interactiveApproval(approved: boolean): void {
    if (approved) this.values.interactiveApprovals++;
    else this.values.interactiveDenials++;
  }

  sandboxShell(result: SandboxShellResult): void {
    if (result.mode === 'inspect') this.values.sandboxShellInspectCalls++;
    else if (result.mode === 'validate')
      this.values.sandboxShellValidateCalls++;
    else this.values.sandboxShellEditCalls++;
    if (result.exitCode !== 0) this.values.sandboxShellFailures++;
    if (result.applied) this.values.sandboxShellAppliedEdits++;
    if (result.rejection) this.values.sandboxShellRejectedEdits++;
    if (result.conflicted) this.values.patchConflicts++;
    this.values.sandboxShellChangedPaths += result.changedPaths.length;
  }

  patchConflict(): void {
    this.values.patchConflicts++;
  }

  persist(pi: ExtensionAPI): void {
    pi.appendEntry(AUTONOMY_METRICS_ENTRY, { ...this.values });
  }
}

export function recordPatchConflict(): void {
  activeCollector?.patchConflict();
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
