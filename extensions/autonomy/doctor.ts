import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import * as path from 'node:path';
import {
  type BuildSystemPromptOptions,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import { delegateStateRoot } from '../delegate/isolation';
import {
  discoverAncestorSkillDefinitions,
  type SkillDefinition,
} from '../system-prompt';
import type { WorkflowDiagnostic } from './types';

const ROOT_ALLOWLIST = new Set([
  '.agents',
  '.gitignore',
  'AGENTS.md',
  'README.md',
  'mg',
]);
const LARGE_INSTRUCTION_BYTES = 24 * 1024;

function ancestorWorkspace(cwd: string): string | undefined {
  let current = realpathSync(cwd);
  while (true) {
    if (
      existsSync(path.join(current, 'AGENTS.md')) &&
      existsSync(path.join(current, '.agents')) &&
      existsSync(path.join(current, 'mg'))
    )
      return current;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function groupSkills(
  definitions: SkillDefinition[],
): Map<string, SkillDefinition[]> {
  const groups = new Map<string, SkillDefinition[]>();
  for (const definition of definitions) {
    const group = groups.get(definition.name) ?? [];
    group.push(definition);
    groups.set(definition.name, group);
  }
  return groups;
}

function parseSkillName(file: string): string {
  try {
    const content = readFileSync(file, 'utf8');
    return (
      /^---\s*\r?\n([\s\S]*?)\r?\n---/
        .exec(content)?.[1]
        ?.split(/\r?\n/)
        .find((line) => /^name\s*:/.test(line))
        ?.replace(/^name\s*:\s*/, '')
        .trim()
        .replace(/^['"]|['"]$/g, '') ?? path.basename(path.dirname(file))
    );
  } catch {
    return path.basename(path.dirname(file));
  }
}

function workspaceSkillDefinitions(workspace: string): SkillDefinition[] {
  const roots = [path.join(workspace, '.agents', 'skills')];
  try {
    for (const entry of readdirSync(workspace, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      roots.push(path.join(workspace, entry.name, '.agents', 'skills'));
    }
  } catch {
    return [];
  }
  const definitions: SkillDefinition[] = [];
  const walk = (directory: string, depth: number) => {
    if (!existsSync(directory) || depth > 3 || definitions.length >= 500)
      return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target, depth + 1);
      else if (entry.isFile() && entry.name === 'SKILL.md')
        definitions.push({
          name: parseSkillName(target),
          filePath: target,
          skillDir: path.dirname(target),
        });
    }
  };
  for (const root of roots) walk(root, 0);
  return definitions;
}

function commandDiagnostics(
  files: Array<{ path: string; content?: string }>,
  commandNames: string[],
): WorkflowDiagnostic[] {
  const known = new Set(commandNames);
  const referenced = new Map<string, string>();
  for (const file of files) {
    const content =
      file.content ??
      (existsSync(file.path) ? readFileSync(file.path, 'utf8') : '');
    for (const match of content.matchAll(/`\/(\w[\w-]*)(?=\s|`)[^`]*`/g))
      referenced.set(match[1], file.path);
  }
  return [...referenced]
    .filter(([command]) => !known.has(command))
    .map(([command, ownerPath]) => ({
      severity: 'warning' as const,
      code: 'stale-command-reference',
      message: `Instruction references unavailable command /${command}: ${ownerPath}`,
      owner: 'instruction owner',
      remediation:
        'Update the instruction or restore the command registration.',
    }));
}

function commitRuleDiagnostics(
  files: Array<{ path: string; content?: string }>,
): WorkflowDiagnostic[] {
  const content = files
    .map(
      (file) =>
        file.content ??
        (existsSync(file.path) ? readFileSync(file.path, 'utf8') : ''),
    )
    .join('\n');
  const conflicts = [
    {
      name: 'ticket requirement',
      required: /ticket[^.\n]{0,80}(?:required|must include)/i,
      forbidden: /ticket[^.\n]{0,80}(?:forbidden|must not include)/i,
    },
    {
      name: 'conventional prefix',
      required: /conventional[^.\n]{0,80}(?:required|must)/i,
      forbidden: /conventional[^.\n]{0,80}(?:forbidden|must not)/i,
    },
    {
      name: 'commit tense',
      required: /imperative[^.\n]{0,80}(?:required|must)/i,
      forbidden: /past tense[^.\n]{0,80}(?:required|must)/i,
    },
  ].filter(
    (item) => item.required.test(content) && item.forbidden.test(content),
  );
  return conflicts.map((conflict) => ({
    severity: 'warning' as const,
    code: 'commit-rule-conflict',
    message: `Applicable instructions contain an explicit ${conflict.name} conflict.`,
    owner: 'repository instruction owners',
    remediation:
      'Inspect the active repository commit skill and local AGENTS.md; do not infer precedence.',
  }));
}

function autonomySettingsDiagnostics(): WorkflowDiagnostic[] {
  const settingsPath = path.join(getAgentDir(), 'settings.json');
  if (!existsSync(settingsPath)) return [];
  try {
    const root = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      autonomy?: Record<string, unknown>;
    };
    if (!root.autonomy) return [];
    const diagnostics: WorkflowDiagnostic[] = [];
    if (
      root.autonomy.profile !== undefined &&
      !['cautious', 'standard', 'high'].includes(String(root.autonomy.profile))
    )
      diagnostics.push({
        severity: 'error',
        code: 'autonomy-profile-invalid',
        message: 'settings.json contains an unknown autonomy profile.',
        owner: 'Pi user settings',
        remediation: 'Use cautious, standard, or high.',
      });
    if (
      root.autonomy.mode !== undefined &&
      !['observe', 'canary', 'enforce'].includes(String(root.autonomy.mode))
    )
      diagnostics.push({
        severity: 'error',
        code: 'autonomy-mode-invalid',
        message: 'settings.json contains an unknown autonomy mode.',
        owner: 'Pi user settings',
        remediation: 'Use observe, canary, or enforce.',
      });
    const capabilities = root.autonomy.capabilities;
    if (
      capabilities !== undefined &&
      (!Array.isArray(capabilities) ||
        capabilities.some(
          (item) =>
            typeof item !== 'string' ||
            ![
              'inspect',
              'edit',
              'local-git',
              'deliver',
              'destructive',
            ].includes(item),
        ))
    )
      diagnostics.push({
        severity: 'error',
        code: 'autonomy-capabilities-invalid',
        message:
          'settings.json autonomy.capabilities must contain only supported capability names.',
        owner: 'Pi user settings',
      });
    const scope = root.autonomy.scope;
    if (
      scope !== undefined &&
      (!Array.isArray(scope) ||
        scope.some((item) => typeof item !== 'string' || item.length === 0))
    )
      diagnostics.push({
        severity: 'error',
        code: 'autonomy-scope-invalid',
        message: 'settings.json autonomy.scope must contain non-empty paths.',
        owner: 'Pi user settings',
      });
    for (const field of ['trustedRoots', 'autoApprove'] as const) {
      const value = root.autonomy[field];
      if (
        value !== undefined &&
        (!Array.isArray(value) ||
          value.some((item) => typeof item !== 'string' || item.length === 0))
      )
        diagnostics.push({
          severity: 'error',
          code: `autonomy-${field}-invalid`,
          message: `settings.json autonomy.${field} must contain non-empty strings.`,
          owner: 'Pi user settings',
        });
    }
    return diagnostics;
  } catch (error) {
    return [
      {
        severity: 'error',
        code: 'agent-settings-invalid-json',
        message: `Cannot parse Pi settings: ${error instanceof Error ? error.message : String(error)}`,
        owner: 'Pi user settings',
      },
    ];
  }
}

function instructionDiagnostics(
  files: Array<{ path: string }>,
): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const file of files) {
    if (!existsSync(file.path)) {
      diagnostics.push({
        severity: 'error',
        code: 'instruction-path-missing',
        message: `Loaded instruction path is missing: ${file.path}`,
        owner: 'instruction owner',
        remediation:
          'Restore the file or remove the stale resource declaration.',
      });
      continue;
    }
    const size = statSync(file.path).size;
    if (size > LARGE_INSTRUCTION_BYTES)
      diagnostics.push({
        severity: 'info',
        code: 'instruction-oversized',
        message: `Always-on instruction file is ${size} bytes: ${file.path}`,
        owner: 'instruction owner',
        remediation:
          'Keep critical policy eager and move conditional procedure to a routed skill.',
      });
  }
  return diagnostics;
}

function allowlistDiagnostics(workspace: string): WorkflowDiagnostic[] {
  try {
    const tracked = execFileSync('git', ['-C', workspace, 'ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);
    const leaks = tracked.filter(
      (file) => !ROOT_ALLOWLIST.has(file.split('/')[0] ?? ''),
    );
    return leaks.length === 0
      ? []
      : [
          {
            severity: 'error',
            code: 'workspace-allowlist-leak',
            message: `Workspace metadata repository tracks disallowed roots: ${[...new Set(leaks.map((file) => file.split('/')[0]))].join(', ')}`,
            owner: 'workspace metadata',
            remediation:
              'Remove the leaked root from workspace tracking without touching the sibling repository.',
          },
        ];
  } catch (error) {
    return [
      {
        severity: 'warning',
        code: 'allowlist-check-failed',
        message: `Could not inspect workspace allowlist: ${error instanceof Error ? error.message : String(error)}`,
        owner: 'workspace metadata',
      },
    ];
  }
}

function isolationDiagnostics(): WorkflowDiagnostic[] {
  const root = path.join(delegateStateRoot(), 'delegate-worktrees', 'v1');
  const diagnostics: WorkflowDiagnostic[] = [];
  const legacy = path.join(getAgentDir(), '.delegate-worktrees', 'v1');
  if (existsSync(legacy))
    diagnostics.push({
      severity: 'warning',
      code: 'delegate-isolation-legacy-state',
      message: `Legacy delegate state exists inside the agent repository: ${legacy}`,
      owner: 'Pi autonomy extension',
      remediation:
        'Inspect and explicitly clean retained legacy worktrees; new state is stored outside target repositories.',
    });
  if (!existsSync(root)) return diagnostics;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true }).slice(
      0,
      500,
    )) {
      if (!entry.isDirectory() || entry.name === 'archive') continue;
      if (entry.name === 'locks') {
        const lockFiles = readdirSync(path.join(root, entry.name));
        const locks = lockFiles.filter((file) => file.endsWith('.lock'));
        const stale = lockFiles.filter((file) => file.includes('.lock.stale-'));
        if (locks.length > 0)
          diagnostics.push({
            severity: 'warning',
            code: 'patch-broker-lock-present',
            message: `${locks.length} patch-broker lock(s) are present; they may be active or left by an interrupted process.`,
            owner: 'Pi autonomy extension',
            remediation:
              'Verify no Pi process owns the lock before any manual cleanup.',
          });
        if (stale.length > 0)
          diagnostics.push({
            severity: 'info',
            code: 'patch-broker-stale-lock-archive',
            message: `${stale.length} stale patch-broker lock record(s) were recovered and retained for diagnosis.`,
            owner: 'Pi autonomy extension',
          });
        continue;
      }
      const directory = path.join(root, entry.name);
      const recordPath = path.join(directory, 'record.json');
      if (existsSync(recordPath)) {
        try {
          const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
            version?: unknown;
            status?: unknown;
            updatedAt?: unknown;
          };
          if (record.version !== 1)
            diagnostics.push({
              severity: 'error',
              code: 'delegate-isolation-schema-mismatch',
              message: `Unsupported delegate isolation schema in ${entry.name}: ${String(record.version)}`,
              owner: 'Pi autonomy extension',
              remediation:
                'Do not mutate the record; use the matching Pi version or an explicit migration.',
            });
          if (record.status === 'running')
            diagnostics.push({
              severity: 'warning',
              code: 'delegate-isolation-running-retained',
              message: `Delegate isolation is marked running: ${entry.name} (${String(record.updatedAt ?? 'unknown time')}).`,
              owner: 'Pi autonomy extension',
              remediation:
                'Verify the owner process; /delegate-patch discard recovers only demonstrably stale owners.',
            });
        } catch (error) {
          diagnostics.push({
            severity: 'error',
            code: 'delegate-isolation-record-invalid',
            message: `Cannot parse delegate isolation record ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
            owner: 'Pi autonomy extension',
          });
        }
      }
      if (existsSync(path.join(directory, 'recovery.json')))
        diagnostics.push({
          severity: 'warning',
          code: 'delegate-isolation-recovery-retained',
          message: `Failed isolation recovery state is retained: ${entry.name}`,
          owner: 'Pi autonomy extension',
          remediation:
            'Inspect the recovery record and Git worktree list; do not delete it blindly.',
        });
    }
  } catch (error) {
    diagnostics.push({
      severity: 'warning',
      code: 'delegate-isolation-check-failed',
      message: `Could not inspect isolation lifecycle state: ${error instanceof Error ? error.message : String(error)}`,
      owner: 'Pi autonomy extension',
    });
  }
  return diagnostics;
}

function workflowConfigDiagnostics(workspace: string): WorkflowDiagnostic[] {
  const configPath = path.join(workspace, 'mg', 'mg.config.json');
  if (!existsSync(configPath))
    return [
      {
        severity: 'error',
        code: 'mg-config-missing',
        message: `Workspace control-plane config is missing: ${configPath}`,
        owner: 'mg',
      },
    ];
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      repos?: Array<{ name?: unknown; path?: unknown }>;
    };
    const diagnostics: WorkflowDiagnostic[] = [];
    for (const repo of config.repos ?? []) {
      if (typeof repo.name !== 'string' || typeof repo.path !== 'string') {
        diagnostics.push({
          severity: 'error',
          code: 'mg-config-invalid-repository',
          message:
            'mg config contains a repository without a stable name/path.',
          owner: 'mg',
        });
      } else if (!existsSync(path.resolve(workspace, repo.path))) {
        diagnostics.push({
          severity: 'warning',
          code: 'mg-repository-path-missing',
          message: `Configured repository path is unavailable for ${repo.name}.`,
          owner: 'repository owner',
          remediation:
            'Correct workspace-local configuration; do not edit the product repository.',
        });
      }
    }
    return diagnostics;
  } catch (error) {
    return [
      {
        severity: 'error',
        code: 'mg-config-invalid-json',
        message: `Cannot parse mg config: ${error instanceof Error ? error.message : String(error)}`,
        owner: 'mg',
      },
    ];
  }
}

export function collectWorkflowDiagnostics(options: {
  cwd: string;
  systemPromptOptions: BuildSystemPromptOptions;
  flags: Record<string, boolean | string | undefined>;
  commandNames?: string[];
}): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const active = options.systemPromptOptions.skills ?? [];
  const activeGroups = new Map<string, typeof active>();
  for (const skill of active) {
    const group = activeGroups.get(skill.name) ?? [];
    group.push(skill);
    activeGroups.set(skill.name, group);
    if (!existsSync(skill.filePath))
      diagnostics.push({
        severity: 'error',
        code: 'active-skill-path-missing',
        message: `Loaded skill path is missing: ${skill.filePath}`,
        owner: 'skill owner',
      });
  }
  for (const [name, skills] of activeGroups) {
    if (skills.length > 1)
      diagnostics.push({
        severity: 'ambiguity',
        code: 'active-skill-collision',
        message: `Multiple loaded skills share name ${name}: ${skills.map((skill) => skill.filePath).join(', ')}`,
        owner: 'Pi skill resolver',
        remediation:
          'Use a qualified identity; do not infer precedence from load order.',
      });
  }

  const workspace = ancestorWorkspace(options.cwd);
  const definitions = [
    ...discoverAncestorSkillDefinitions(options.cwd),
    ...(workspace ? workspaceSkillDefinitions(workspace) : []),
  ].filter(
    (definition, index, all) =>
      all.findIndex((item) => item.filePath === definition.filePath) === index,
  );
  for (const [name, group] of groupSkills(definitions)) {
    if (group.length < 2 || (activeGroups.get(name)?.length ?? 0) > 1) continue;
    const activeDefinition = activeGroups.get(name)?.[0];
    if (activeDefinition)
      diagnostics.push({
        severity: 'info',
        code: 'active-skill-precedence',
        message: `Observed active skill ${name}: ${activeDefinition.filePath}. Other applicable definitions: ${group
          .filter((item) => item.filePath !== activeDefinition.filePath)
          .map((item) => item.filePath)
          .join(', ')}`,
        owner: 'Pi skill resolver',
        remediation:
          'Treat the reported active path as runtime evidence; use qualified identities when selecting a collision explicitly.',
      });
    diagnostics.push({
      severity: 'warning',
      code: 'inactive-duplicate-skill',
      message: `Inactive duplicate skill name ${name}: ${group.map((item) => item.filePath).join(', ')}`,
      owner: 'respective repository owners',
      remediation:
        'No failure and no repository edit required; qualify the skill if definitions are loaded together.',
    });
  }

  const contextFiles = options.systemPromptOptions.contextFiles ?? [];
  const proceduralFiles = [
    ...contextFiles,
    ...active.map((skill) => ({
      path: skill.filePath,
      content: existsSync(skill.filePath)
        ? readFileSync(skill.filePath, 'utf8')
        : '',
    })),
  ];
  diagnostics.push(...instructionDiagnostics(contextFiles));
  diagnostics.push(
    ...commandDiagnostics(proceduralFiles, options.commandNames ?? []),
  );
  diagnostics.push(...commitRuleDiagnostics(proceduralFiles));
  diagnostics.push(...autonomySettingsDiagnostics());
  if (workspace) {
    diagnostics.push(...allowlistDiagnostics(workspace));
    diagnostics.push(...workflowConfigDiagnostics(workspace));
  }
  diagnostics.push(...isolationDiagnostics());
  if (options.flags['context-governor'] !== true)
    diagnostics.push({
      severity: 'info',
      code: 'context-governor-disabled',
      message: 'Context governor is disabled.',
      owner: 'Pi user settings',
    });
  if (options.flags['autonomy-enforce'] !== true)
    diagnostics.push({
      severity: 'info',
      code: 'capability-enforcement-observe-only',
      message:
        'Capability broker is observe-only; supported tool calls are not blocked.',
      owner: 'Pi user settings',
      remediation:
        'Use canary mode for repository-aware auto-leases and effect-contained shell execution, or keep observe mode for diagnostics only.',
    });
  if (options.flags['autonomy-mode'] === 'canary')
    diagnostics.push({
      severity: 'info',
      code: 'capability-enforcement-canary',
      message:
        'Capability broker canary is active: trusted inspect/edit leases are automatic, sandbox_shell effects are enforced, and aggregate local telemetry is recorded in session history.',
      owner: 'Pi autonomy extension',
      remediation:
        'Analyze representative sessions with npm run session:metrics; use --no-autonomy-enforce for immediate observe-only rollback.',
    });
  if (options.flags['autonomy-scheduler'] === true)
    diagnostics.push({
      severity: 'info',
      code: 'scheduler-provider-targets-advisory',
      message:
        'Todo scheduler uses hard local child, concurrency, duration, turn, and compute-unit limits; provider output-token and cost values are advisory targets, and one bounded-concurrency in-flight batch may overshoot by a provider-unbounded amount.',
      owner: 'Pi autonomy extension',
      remediation:
        'Use maxTurns/maxComputeUnits for deterministic admission and review measured target overshoot before increasing profile limits.',
    });
  return diagnostics;
}

export function formatWorkflowDiagnostics(
  diagnostics: WorkflowDiagnostic[],
): string {
  const order = ['error', 'ambiguity', 'warning', 'info'] as const;
  const lines = ['Workflow doctor'];
  for (const severity of order) {
    const items = diagnostics.filter((item) => item.severity === severity);
    if (items.length === 0) continue;
    lines.push(`\n${severity.toUpperCase()} (${items.length})`);
    for (const item of items) {
      lines.push(`- [${item.code}] ${item.message} Owner: ${item.owner}.`);
      if (item.remediation) lines.push(`  Remediation: ${item.remediation}`);
    }
  }
  if (diagnostics.length === 0) lines.push('\nNo findings.');
  return lines.join('\n');
}
