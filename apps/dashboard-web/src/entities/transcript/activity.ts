import {
  type projectActivityGroups,
  stringArg,
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
  lineChanges?: FileLineChanges;
  role: 'edit' | 'read' | 'search' | 'command' | 'other';
  state: 'complete' | 'pending' | 'failed';
};

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

type FileLineChanges = {
  added: number;
  changed: number;
  removed: number;
};

function textLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r\n|\r|\n/u);
  if (/\r\n|\r|\n$/u.test(text)) lines.pop();
  return lines;
}

function replacementLineChanges(
  oldText: string,
  newText: string,
): FileLineChanges {
  const before = textLines(oldText);
  const after = textLines(newText);
  let start = 0;
  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (
    start <= beforeEnd &&
    start <= afterEnd &&
    before[start] === after[start]
  )
    start += 1;
  while (
    beforeEnd >= start &&
    afterEnd >= start &&
    before[beforeEnd] === after[afterEnd]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const removedLines = Math.max(0, beforeEnd - start + 1);
  const addedLines = Math.max(0, afterEnd - start + 1);
  const changed = Math.min(removedLines, addedLines);
  return {
    added: addedLines - changed,
    changed,
    removed: removedLines - changed,
  };
}

function fileLineChanges(
  name: string,
  args: unknown,
): FileLineChanges | undefined {
  const record = activityArgs(args);
  if (name === 'write' && typeof record?.content === 'string')
    return { added: textLines(record.content).length, changed: 0, removed: 0 };
  if (name !== 'edit') return undefined;
  const edits = arrayArg(args, 'edits');
  if (!edits.length) return undefined;
  const total: FileLineChanges = { added: 0, changed: 0, removed: 0 };
  let counted = false;
  for (const edit of edits) {
    const replacement = activityArgs(edit);
    if (
      typeof replacement?.oldText !== 'string' ||
      typeof replacement.newText !== 'string'
    )
      continue;
    const changes = replacementLineChanges(
      replacement.oldText,
      replacement.newText,
    );
    total.added += changes.added;
    total.changed += changes.changed;
    total.removed += changes.removed;
    counted = true;
  }
  return counted ? total : undefined;
}

function fileLineChangeLabel(changes: FileLineChanges): string {
  return [
    changes.added ? `+${changes.added}` : undefined,
    changes.changed ? `~${changes.changed}` : undefined,
    changes.removed ? `-${changes.removed}` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
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
  const status = 'status' in tool ? tool.status : undefined;
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
  let argument: string | undefined;
  let lineChanges: FileLineChanges | undefined;
  if (name === 'bash' || name === 'shell' || name === 'exec') {
    action = 'Running';
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
    lineChanges = fileLineChanges(name, tool.args);
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
    ? fileLineChangeLabel(lineChanges)
    : undefined;
  return {
    label: [action, displayedArgument, changeLabel].filter(Boolean).join(' '),
    action,
    ...(displayedArgument ? { argument: displayedArgument } : {}),
    ...(lineChanges ? { lineChanges } : {}),
    role,
    state,
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

export function activityGroupMetadata(
  summary: Pick<ActivityGroupSummary, 'toolCount' | 'failureCount'>,
): string {
  const parts = [
    `${summary.toolCount} tool call${summary.toolCount === 1 ? '' : 's'}`,
  ];
  if (summary.failureCount > 0)
    parts.push(
      `${summary.failureCount} failed attempt${summary.failureCount === 1 ? '' : 's'}`,
    );
  return parts.join(' · ');
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
