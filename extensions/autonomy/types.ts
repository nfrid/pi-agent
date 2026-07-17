export const CAPABILITIES = [
  'inspect',
  'edit',
  'local-git',
  'deliver',
  'destructive',
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type AutonomyProfileName = 'cautious' | 'standard' | 'high';
export type AutonomyMode = 'observe' | 'canary' | 'enforce';
export type AutonomyMetricMode = AutonomyMode | 'mixed';

export interface RepositoryAuthority {
  root: string;
  scopes: Partial<Record<Capability, string[]>>;
}

export interface CapabilityEnvelope {
  version: 2;
  repositories: RepositoryAuthority[];
  confirmations: Capability[];
  source: 'session-default' | 'cli' | 'user-command' | 'agent-lease';
  createdAt: number;
  expiresAt?: number;
}

export interface LegacyCapabilityEnvelope {
  version: 1;
  repositoryRoot: string;
  paths: string[];
  capabilities: Capability[];
  confirmations: Capability[];
  source: 'session-default' | 'cli' | 'user-command';
  createdAt: number;
  expiresAt?: number;
}

export interface EnvelopeProposal {
  capabilities: Capability[];
  paths: string[];
  rationale: string;
  ttlMs?: number;
}

export interface EnvelopeDelta {
  addedCapabilities: Capability[];
  removedCapabilities: Capability[];
  addedRepositories: string[];
  removedRepositories: string[];
  expandedPaths: string[];
  narrowedPaths: string[];
  oldExpiresAt?: number;
  newExpiresAt?: number;
}

export const HARD_AUTONOMY_DEFAULTS = {
  localGit: false,
  delivery: false,
  destructive: false,
  automaticPatchApply: false,
} as const;

export interface AutonomyProfile {
  name: AutonomyProfileName;
  confirmReversibleChoices: boolean;
  scheduler: {
    maxChildren: number;
    maxConcurrency: number;
    maxDurationMs: number;
    maxTurns: number;
    maxComputeUnits: number;
    targetOutputTokens: number;
    targetCostUsd: number;
  };
}

export interface AutonomyConfig {
  profile: AutonomyProfileName;
  mode: AutonomyMode;
  capabilities: Capability[];
  scope: string[];
  trustedRoots: string[];
  autoApprove: Capability[];
}

export type PolicyReasonCode =
  | 'allowed'
  | 'expired-envelope'
  | 'missing-capability'
  | 'outside-scope'
  | 'uncontrolled-shell'
  | 'sandbox-unavailable'
  | 'invalid-target'
  | 'write-scope-required'
  | 'confirmation-required'
  | 'unsupported-tool';

export interface PolicyDecision {
  allowed: boolean;
  code: PolicyReasonCode;
  reason: string;
  capability?: Capability;
  target?: string;
}

export interface AutonomyMetrics {
  version: 2;
  mode: AutonomyMetricMode;
  startedAt: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  repeatedReads: number;
  repeatedStatuses: number;
  delegateCalls: number;
  delegateInputTokens: number;
  delegateOutputTokens: number;
  delegateCostUsd: number;
  blockedCapabilityAttempts: number;
  observedCapabilityViolations: number;
  autoApprovedLeases: number;
  leasedRepositories: number;
  leasedPaths: number;
  interactiveApprovals: number;
  interactiveDenials: number;
  sandboxShellInspectCalls: number;
  sandboxShellValidateCalls: number;
  sandboxShellEditCalls: number;
  sandboxShellFailures: number;
  sandboxShellAppliedEdits: number;
  sandboxShellRejectedEdits: number;
  sandboxShellChangedPaths: number;
  patchConflicts: number;
  policyDenials: Partial<Record<PolicyReasonCode, number>>;
  /** Bounded content hashes used only to preserve repeat detection across resume. */
  readSelectionHashes: string[];
  statusSelectionHashes: string[];
}

export interface LegacyAutonomyMetrics {
  version: 1;
  startedAt: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  repeatedReads: number;
  repeatedStatuses: number;
  delegateCalls: number;
  delegateInputTokens: number;
  delegateOutputTokens: number;
  delegateCostUsd: number;
  blockedCapabilityAttempts: number;
  observedCapabilityViolations: number;
  patchConflicts: number;
  readSelectionHashes: string[];
  statusSelectionHashes: string[];
}

export interface WorkflowDiagnostic {
  severity: 'error' | 'ambiguity' | 'warning' | 'info';
  code: string;
  message: string;
  owner: string;
  remediation?: string;
}
