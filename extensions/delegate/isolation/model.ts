/** Persistent and boundary types shared by isolation responsibility modules. */
export type DependencyMode = 'auto' | 'link' | 'isolated';
export type EffectiveDependencyMode = 'link' | 'isolated';

export interface IsolationRecord {
  version: 1;
  id: string;
  sessionToken?: string;
  repositoryRoot: string;
  worktreePath: string;
  workingDirectory: string;
  scratchPath: string;
  baseHead: string;
  requestedScopes: string[];
  writablePaths: string[];
  requestedDependencyMode: DependencyMode;
  dependencyMode: EffectiveDependencyMode;
  dependencyLinks: string[];
  manifestHash: string;
  backend: 'macos-sandbox-exec';
  createdAt: string;
  updatedAt: string;
  runOutcome?: 'success' | 'error' | 'aborted' | 'timed-out' | 'unknown';
  runOwner?: { pid: number; identity: string; startedAt: string };
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
    sha256: string;
    size: number;
    changedPaths: string[];
    diffCheckPassed: boolean;
    requiresIsolatedDependencyValidation: boolean;
    unsafeReason?: string;
  };
  error?: string;
}

export interface PreparedIsolation {
  record: IsolationRecord;
  profilePath: string;
  env: NodeJS.ProcessEnv;
}

export interface IsolationPreparation {
  isolation?: PreparedIsolation;
  fallbackReason?: string;
}

export interface PreparedChildAuth {
  directory: string;
  env: NodeJS.ProcessEnv;
}

export interface PreparedReadOnlySandbox {
  id: string;
  cwd: string;
  directory: string;
  profilePath: string;
  shellProfilePath: string;
  env: NodeJS.ProcessEnv;
}

export type PatchEligibilityCode =
  | 'eligible'
  | 'record-not-ready'
  | 'run-not-successful'
  | 'validation-required'
  | 'unsafe-patch'
  | 'isolated-dependencies-required'
  | 'invalid-patch-bytes'
  | 'unsafe-patch-path'
  | 'stale-parent-head'
  | 'dirty-parent'
  | 'patch-check-failed'
  | 'patch-apply-failed'
  | 'post-apply-conflict';

export interface PatchEligibility {
  eligible: boolean;
  code: PatchEligibilityCode;
  reason: string;
}
