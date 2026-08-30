import {
  type ActivityKind,
  type ActivityLineChanges,
  activityToolDurationMs,
  activityToolLineChanges,
  stringArg,
  TOOL_ACTION_LABEL_MAX,
  type ToolDescriptor,
  toolActionSummary,
  toolBaseName,
  toolPath,
  toolRole,
} from '@pi-dashboard/activity-model';

export type ActivityStepTool = ToolDescriptor;

export type ToolStreamSummary = {
  recentTools: readonly string[];
  earlierToolCount: number;
  toolCount: number;
  failureCount: number;
};

export type ToolStreamMetadata = {
  lineChanges: ActivityLineChanges;
  durationMs: number;
  failureCount: number;
};

export type ToolStreamStatus = 'complete' | 'in-progress' | 'failed';

export function toolStreamStatus(
  tools: readonly ActivityStepTool[],
): ToolStreamStatus {
  if (tools.some(isFailedActivityTool)) return 'failed';
  if (
    tools.some((tool) =>
      ['pending', 'running', 'preparing'].includes(tool.status ?? ''),
    )
  )
    return 'in-progress';
  return 'complete';
}

export function toolStreamDurationLabel(milliseconds: number): string {
  return formatCommandDuration(milliseconds);
}

export function toolStreamKindLabel(kind: ActivityKind): string {
  return kind === 'inspect'
    ? 'Inspected'
    : kind === 'mutate'
      ? 'Edited'
      : kind === 'validate'
        ? 'Validated'
        : kind === 'execute'
          ? 'Ran'
          : 'Mixed work';
}

export type ActivityStepParts = {
  label: string;
  action: string;
  argument?: string;
  lineChanges?: ActivityLineChanges;
  role: 'edit' | 'read' | 'search' | 'command' | 'other';
  described?: boolean;
  state: 'complete' | 'pending' | 'failed';
};

function toolResultRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function formatCommandDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`;
}

/** Compact exit code and duration badges for collapsed command steps. */
export function commandStepMeta(
  tool: ActivityStepTool & { result?: unknown; data?: unknown },
): string | undefined {
  const name = toolBaseName(tool.name);
  if (
    name !== 'bash' &&
    name !== 'shell' &&
    name !== 'exec' &&
    name !== 'inspect_shell'
  )
    return undefined;
  const parts: string[] = [];
  const result = toolResultRecord(tool.result);
  const data = toolResultRecord(tool.data);
  const exitCode = result?.exitCode;
  if (typeof exitCode === 'number' && Number.isFinite(exitCode))
    parts.push(`exit ${exitCode}`);
  const durationMs =
    (typeof data?.durationMs === 'number' && Number.isFinite(data.durationMs)
      ? data.durationMs
      : undefined) ??
    (typeof result?.durationMs === 'number' &&
    Number.isFinite(result.durationMs)
      ? result.durationMs
      : undefined);
  if (durationMs !== undefined) parts.push(formatCommandDuration(durationMs));
  return parts.length ? parts.join(' · ') : undefined;
}

export function displayActivityPath(value: string, cwd = ''): string {
  const normalized = value.replace(/\\/gu, '/').replace(/\/+/gu, '/');
  const normalizedCwd = cwd
    .replace(/\\/gu, '/')
    .replace(/\/+/gu, '/')
    .replace(/\/$/u, '');
  const windowsAbsolute = /^[A-Za-z]:\//u.test(normalized);
  if (!normalized.startsWith('/') && !windowsAbsolute)
    return normalized.replace(/^\.\//u, '');
  if (!normalizedCwd) return normalized;
  const caseInsensitive =
    windowsAbsolute && /^[A-Za-z]:\//u.test(normalizedCwd);
  const comparablePath = caseInsensitive
    ? normalized.toLowerCase()
    : normalized;
  const comparableCwd = caseInsensitive
    ? normalizedCwd.toLowerCase()
    : normalizedCwd;
  if (comparablePath === comparableCwd) return '.';
  const prefix = `${comparableCwd}/`;
  return comparablePath.startsWith(prefix)
    ? normalized.slice(normalizedCwd.length + 1)
    : normalized;
}

function compactActivityArgument(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function compactActivityDescription(value: string): string {
  const compact = compactActivityArgument(value);
  return compact.length > TOOL_ACTION_LABEL_MAX
    ? `${compact.slice(0, TOOL_ACTION_LABEL_MAX - 1)}…`
    : compact;
}

function activityArgs(args: unknown): Record<string, unknown> | undefined {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : undefined;
}

function numberArg(args: unknown, key: string): number | undefined {
  const value = activityArgs(args)?.[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function arrayArg(args: unknown, key: string): readonly unknown[] {
  const value = activityArgs(args)?.[key];
  return Array.isArray(value) ? value : [];
}

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function readPathArgument(path: string, args: unknown, cwd: string): string {
  const displayed = displayActivityPath(path, cwd);
  const offset = numberArg(args, 'offset');
  const limit = numberArg(args, 'limit');
  if (offset === undefined) return displayed;
  const end = limit === undefined ? undefined : offset + Math.max(0, limit - 1);
  return `${displayed}:${offset}${end === undefined ? '' : `–${end}`}`;
}

function activityToolState(tool: ActivityStepTool): ActivityStepParts['state'] {
  if (isFailedActivityTool(tool)) return 'failed';
  const status = ('status' in tool ? tool.status : undefined) as
    | string
    | undefined;
  return status === 'pending' || status === 'running' || status === 'preparing'
    ? 'pending'
    : 'complete';
}

export function activityStepParts(
  tool: ActivityStepTool,
  cwd = '',
): ActivityStepParts {
  const name = toolBaseName(tool.name);
  let role = toolRole(tool.name);
  const state = activityToolState(tool);
  const path = toolPath(tool.args);
  let action: string;
  let described: boolean | undefined;
  let argument: string | undefined;
  let lineChanges: ActivityLineChanges | undefined;
  if (name === 'bash' || name === 'shell' || name === 'exec') {
    const description = stringArg(tool.args, 'description');
    if (description) {
      action = compactActivityDescription(description);
      described = true;
    } else {
      action = 'Running';
    }
    const command =
      stringArg(tool.args, 'command') ??
      stringArg(tool.args, 'cmd') ??
      stringArg(tool.args, 'script');
    if (command) argument = compactActivityArgument(command);
  } else if (name === 'inspect_shell') {
    action = 'Checking';
    const command = stringArg(tool.args, 'command');
    if (command) argument = compactActivityArgument(command);
  } else if (name === 'delegate' || name === 'delegates') {
    role = 'command';
    const operation =
      stringArg(tool.args, 'action') ?? stringArg(tool.args, 'operation');
    action = operation ? `Delegate ${operation}` : 'Delegating';
    argument = stringArg(tool.args, 'name') ?? stringArg(tool.args, 'task');
    const tasks = arrayArg(tool.args, 'tasks');
    if (!argument && tasks.length) argument = countLabel(tasks.length, 'task');
  } else if (name === 'delegate_jobs') {
    role = 'command';
    const operation = stringArg(tool.args, 'action') ?? 'list';
    action =
      operation === 'peek'
        ? 'Checking delegate job'
        : operation === 'feedback'
          ? 'Sending feedback to delegate job'
          : operation === 'cancel'
            ? 'Cancelling delegate jobs'
            : 'Listing delegate jobs';
    argument =
      stringArg(tool.args, 'id') ??
      (arrayArg(tool.args, 'ids').length
        ? countLabel(arrayArg(tool.args, 'ids').length, 'job')
        : undefined);
  } else if (name === 'delegate_changes') {
    role = 'command';
    const operation = stringArg(tool.args, 'action') ?? 'list';
    action =
      operation === 'review'
        ? 'Reviewing delegate changes'
        : operation === 'merge'
          ? 'Merging delegate changes'
          : operation === 'drop'
            ? 'Dropping delegate changes'
            : 'Listing delegate changes';
    const node = stringArg(tool.args, 'node');
    if (node) argument = node;
  } else if (name === 'background') {
    role = 'command';
    const operation = stringArg(tool.args, 'action') ?? 'list';
    action =
      operation === 'start'
        ? 'Starting background command'
        : operation === 'peek'
          ? 'Checking background command'
          : operation === 'stop'
            ? 'Stopping background command'
            : 'Listing background commands';
    argument = stringArg(tool.args, 'title') ?? stringArg(tool.args, 'id');
  } else if (name === 'todo' || name === 'tasks') {
    const operation =
      stringArg(tool.args, 'action') ?? stringArg(tool.args, 'operation');
    action = operation ? `Tasks ${operation}` : 'Updating tasks';
    argument = stringArg(tool.args, 'id') ?? stringArg(tool.args, 'taskId');
    if (!argument && tool.args && typeof tool.args === 'object') {
      const operations = (tool.args as { operations?: unknown }).operations;
      if (Array.isArray(operations))
        argument = `${operations.length} operation${operations.length === 1 ? '' : 's'}`;
    }
  } else if (name === 'grep' || name === 'find' || name === 'glob') {
    action = 'Searching for';
    const pattern =
      stringArg(tool.args, 'pattern') ?? stringArg(tool.args, 'query');
    const location = path ? displayActivityPath(path, cwd) : undefined;
    argument = [pattern, location ? `in ${location}` : undefined]
      .filter(Boolean)
      .join(' ');
  } else if (name === 'web_search' || name === 'search_web') {
    role = 'search';
    action = 'Searching the web';
    const queries = arrayArg(tool.args, 'queries');
    argument =
      stringArg(tool.args, 'query') ??
      stringArg(tool.args, 'q') ??
      (queries.length ? countLabel(queries.length, 'query') : undefined);
  } else if (name === 'fetch_content') {
    role = 'read';
    action = 'Fetching';
    const urls = arrayArg(tool.args, 'urls');
    argument =
      stringArg(tool.args, 'url') ??
      stringArg(tool.args, 'href') ??
      (urls.length ? countLabel(urls.length, 'page') : undefined);
  } else if (name === 'get_search_content') {
    role = 'read';
    action = 'Reading search result';
    argument =
      stringArg(tool.args, 'heading') ??
      stringArg(tool.args, 'literal') ??
      stringArg(tool.args, 'query');
    if (!argument) {
      const page =
        numberArg(tool.args, 'urlIndex') ?? numberArg(tool.args, 'queryIndex');
      if (page !== undefined) argument = `result ${page + 1}`;
    }
  } else if (path) {
    const edits = arrayArg(tool.args, 'edits');
    const changes = activityToolLineChanges(tool);
    lineChanges = changes;
    action =
      name === 'read'
        ? 'Reading'
        : name === 'ls'
          ? 'Listing'
          : name === 'write'
            ? 'Writing'
            : 'Editing';
    argument =
      name === 'read'
        ? readPathArgument(path, tool.args, cwd)
        : `${displayActivityPath(path, cwd)}${!lineChanges && edits.length ? ` · ${countLabel(edits.length, 'change')}` : ''}`;
  } else {
    action = `Running ${name}`;
    const fallback = toolActionSummary(tool);
    const detail = fallback.slice(name.length).trim().replace(/^:\s*/u, '');
    if (detail) argument = detail;
  }
  const displayedArgument = argument
    ? compactActivityArgument(argument)
    : undefined;
  const changeLabel = lineChanges
    ? [
        lineChanges.added ? `+${lineChanges.added}` : undefined,
        lineChanges.changed ? `~${lineChanges.changed}` : undefined,
        lineChanges.removed ? `-${lineChanges.removed}` : undefined,
      ]
        .filter(Boolean)
        .join(' ')
    : undefined;
  return {
    label: compactActivityDescription(
      [action, displayedArgument, changeLabel].filter(Boolean).join(' '),
    ),
    action,
    ...(displayedArgument ? { argument: displayedArgument } : {}),
    ...(lineChanges ? { lineChanges } : {}),
    role,
    state,
    described,
  };
}

function isFailedActivityTool(tool: unknown): boolean {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
  const candidate = tool as Record<string, unknown>;
  return (
    candidate.isError === true ||
    candidate.status === 'error' ||
    candidate.status === 'failed'
  );
}

export function toolStreamSummary(
  tools: readonly ActivityStepTool[],
): ToolStreamSummary {
  const recentTools = tools.slice(-3).map((tool) => tool.name);
  const failureCount = tools.filter(isFailedActivityTool).length;
  return {
    recentTools,
    earlierToolCount: Math.max(0, tools.length - recentTools.length),
    toolCount: tools.length,
    failureCount,
  };
}

export function toolStreamMetadata(
  tools: readonly ActivityStepTool[],
): ToolStreamMetadata {
  const lineChanges: ActivityLineChanges = {
    added: 0,
    changed: 0,
    removed: 0,
  };
  let durationMs = 0;
  for (const tool of tools) {
    const changes = activityToolLineChanges(tool);
    if (changes) {
      lineChanges.added += changes.added;
      lineChanges.changed += changes.changed;
      lineChanges.removed += changes.removed;
    }
    durationMs += activityToolDurationMs(tool) ?? 0;
  }
  return {
    lineChanges,
    durationMs,
    failureCount: tools.filter(isFailedActivityTool).length,
  };
}

export function toolStreamMetadataLabel(
  tools: readonly ActivityStepTool[],
): string {
  const summary = toolStreamSummary(tools);
  const metadata = toolStreamMetadata(tools);
  const changes = [
    metadata.lineChanges.added ? `+${metadata.lineChanges.added}` : undefined,
    metadata.lineChanges.changed
      ? `~${metadata.lineChanges.changed}`
      : undefined,
    metadata.lineChanges.removed
      ? `-${metadata.lineChanges.removed}`
      : undefined,
  ].filter(Boolean);
  return [
    `${summary.toolCount} call${summary.toolCount === 1 ? '' : 's'}`,
    changes.length ? changes.join(' ') : undefined,
    metadata.durationMs > 0
      ? formatCommandDuration(metadata.durationMs)
      : undefined,
    metadata.failureCount > 0 ? `${metadata.failureCount} failed` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}
