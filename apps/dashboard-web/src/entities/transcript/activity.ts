import {
  type ActivityGroupFacts,
  activityGroupFacts,
  type projectActivityGroups,
  stringArg,
  TOOL_ACTION_LABEL_MAX,
  toolActionSummary,
  toolBaseName,
  toolPath,
  toolRole,
} from '@pi-dashboard/activity-model';

export type TranscriptGroup = ReturnType<typeof projectActivityGroups>[number];

export type ActivityGroupSummary = {
  recentTools: readonly string[];
  earlierToolCount: number;
  toolCount: number;
  failureCount: number;
};

type ActivityGroupSummaryInput = Pick<TranscriptGroup, 'tools' | 'toolCount'>;

type ActivityStepTool = TranscriptGroup['tools'][number] & {
  isError?: boolean;
  status?: string;
};

export type ActivityStepParts = {
  label: string;
  action: string;
  argument?: string;
  lineChanges?: ActivityGroupFacts['lineChanges'];
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
  let lineChanges: ActivityGroupFacts['lineChanges'] | undefined;
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
  } else if (name === 'delegate_branches') {
    role = 'command';
    const operation = stringArg(tool.args, 'action') ?? 'list';
    action =
      operation === 'review'
        ? 'Reviewing delegate branch'
        : operation === 'merge'
          ? 'Merging delegate branch'
          : operation === 'drop'
            ? 'Dropping delegate branch'
            : 'Listing delegate branches';
    const id = stringArg(tool.args, 'id');
    if (id) argument = id;
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
  } else if (name === 'artifact_retrieve') {
    role = 'read';
    action = 'Reading artifact';
    const mode = stringArg(tool.args, 'mode');
    const offset = numberArg(tool.args, 'offset');
    const limit = numberArg(tool.args, 'limit');
    if (mode === 'lines' && offset !== undefined)
      argument = `lines ${offset + 1}${limit === undefined ? '' : `–${offset + limit}`}`;
    else argument = mode;
  } else if (path) {
    const edits = arrayArg(tool.args, 'edits');
    const changes = activityGroupFacts([tool]).lineChanges;
    lineChanges =
      changes.added || changes.changed || changes.removed ? changes : undefined;
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

/**
 * Keep the collapsed row bounded and honest: names and outcomes come from the
 * shared activity projection, while opaque tool arguments stay in expanded
 * details rather than being guessed at here. Failure totals are derived from
 * existing tool outcomes so the version-1 contribution contract stays stable.
 */
export function activityGroupSummary(
  group: ActivityGroupSummaryInput,
): ActivityGroupSummary {
  const recentTools = group.tools.slice(-3).map((tool) => tool.name);
  const failureCount = group.tools.filter(isFailedActivityTool).length;
  return {
    recentTools,
    earlierToolCount: Math.max(0, group.tools.length - recentTools.length),
    toolCount: group.toolCount,
    failureCount,
  };
}

export type ActivityGroupMetadataModel = {
  kindLabel: string;
  toolLabel: string;
  lineChanges: ActivityGroupFacts['lineChanges'];
  duration?: string;
  failure?: string;
};

export function activityGroupMetadataModel(
  group: Pick<TranscriptGroup, 'kind' | 'tools' | 'toolCount'>,
  summary: Pick<ActivityGroupSummary, 'failureCount'>,
): ActivityGroupMetadataModel {
  const facts = activityGroupFacts(group.tools);
  return {
    kindLabel:
      group.kind === 'mutate'
        ? 'Edited'
        : group.kind === 'inspect'
          ? 'Inspected'
          : group.kind === 'validate'
            ? 'Validated'
            : group.kind === 'execute'
              ? 'Ran'
              : 'Mixed work',
    toolLabel: `${group.toolCount} tool${group.toolCount === 1 ? '' : 's'}`,
    lineChanges: facts.lineChanges,
    ...(facts.commandDurationMs > 0
      ? { duration: formatCommandDuration(facts.commandDurationMs) }
      : {}),
    ...(summary.failureCount > 0
      ? { failure: `${summary.failureCount} failed` }
      : {}),
  };
}

export function activityGroupMetadata(
  summary: Pick<ActivityGroupSummary, 'toolCount' | 'failureCount'>,
): string;
export function activityGroupMetadata(
  group: Pick<TranscriptGroup, 'kind' | 'status' | 'tools' | 'toolCount'>,
  summary: Pick<ActivityGroupSummary, 'failureCount'>,
): string;
export function activityGroupMetadata(
  groupOrSummary:
    | Pick<TranscriptGroup, 'kind' | 'status' | 'tools' | 'toolCount'>
    | Pick<ActivityGroupSummary, 'toolCount' | 'failureCount'>,
  providedSummary?: Pick<ActivityGroupSummary, 'failureCount'>,
): string {
  if (providedSummary === undefined) {
    const summary = groupOrSummary as Pick<
      ActivityGroupSummary,
      'toolCount' | 'failureCount'
    >;
    const parts = [
      `${summary.toolCount} tool call${summary.toolCount === 1 ? '' : 's'}`,
    ];
    if (summary.failureCount > 0)
      parts.push(
        `${summary.failureCount} failed attempt${summary.failureCount === 1 ? '' : 's'}`,
      );
    return parts.join(' · ');
  }
  const group = groupOrSummary as Pick<
    TranscriptGroup,
    'kind' | 'status' | 'tools' | 'toolCount'
  >;
  const metadata = activityGroupMetadataModel(group, providedSummary);
  const changes = [
    metadata.lineChanges.added ? `+${metadata.lineChanges.added}` : undefined,
    metadata.lineChanges.changed
      ? `~${metadata.lineChanges.changed}`
      : undefined,
    metadata.lineChanges.removed
      ? `-${metadata.lineChanges.removed}`
      : undefined,
  ].filter(Boolean);
  const parts = [
    metadata.kindLabel,
    metadata.toolLabel,
    changes.length ? changes.join(' ') : undefined,
    metadata.duration,
    metadata.failure,
  ];
  return parts.filter(Boolean).join(' · ');
}

export function activityGroupPresentation(
  group: Pick<TranscriptGroup, 'status' | 'toolCount'>,
  expanded: boolean,
): {
  className: 'activity-settled' | 'activity-pending' | 'activity-ended-error';
  icon: '•' | '…' | '!';
  label: string;
  status: TranscriptGroup['status'];
} {
  const detail = expanded ? 'hide detail' : 'show detail';
  if (group.status === 'ended-error')
    return {
      className: 'activity-ended-error',
      icon: '!',
      label: `ended after an error · ${detail}`,
      status: group.status,
    };
  if (group.status === 'preparing')
    return {
      className: 'activity-pending',
      icon: '…',
      label: 'preparing tool call',
      status: group.status,
    };
  if (group.status === 'live')
    return {
      className: 'activity-pending',
      icon: '…',
      label: `in progress · ${detail}`,
      status: group.status,
    };
  return {
    className: 'activity-settled',
    icon: '•',
    label: detail,
    status: group.status,
  };
}
