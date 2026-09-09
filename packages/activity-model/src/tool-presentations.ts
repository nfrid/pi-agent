/**
 * Dashboard/TUI presentation kinds for this repo's custom tools.
 *
 * Builtin write/edit/read/grep/command stay in the dashboard inspector; this
 * map is the shared name contract so adding or renaming an extension tool
 * shows up as a type error until the presenter is updated.
 */
import { stringArg, toolBaseName } from './grouping.js';

export const CUSTOM_TOOL_KIND_BY_NAME = {
  web_search: 'web_search',
  search_web: 'web_search',
  fetch_content: 'fetch_content',
  get_search_content: 'get_search_content',
  delegate: 'delegate',
  delegates: 'delegate',
  delegate_jobs: 'delegate_jobs',
  delegate_changes: 'delegate_changes',
  delegate_gate: 'delegate_gate',
  background: 'background',
  todo: 'todo',
  tasks: 'todo',
} as const;

export type CustomToolName = keyof typeof CUSTOM_TOOL_KIND_BY_NAME;
export type CustomToolKind = (typeof CUSTOM_TOOL_KIND_BY_NAME)[CustomToolName];

export function customToolKind(name: string): CustomToolKind | undefined {
  const base = toolBaseName(name).toLowerCase();
  if (base in CUSTOM_TOOL_KIND_BY_NAME)
    return CUSTOM_TOOL_KIND_BY_NAME[base as CustomToolName];
  return undefined;
}

function recordArgs(args: unknown): Record<string, unknown> | undefined {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : undefined;
}

function stringList(args: unknown, key: string): string[] {
  const value = recordArgs(args)?.[key];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    typeof item === 'string' && item.trim() ? [item.trim()] : [],
  );
}

export type WebSearchPresentation = {
  queries: readonly string[];
  recencyFilter?: string;
  domainCount: number;
  includeContent: boolean;
};

export function webSearchPresentation(args: unknown): WebSearchPresentation {
  const queries = stringList(args, 'queries');
  const query = stringArg(args, 'query');
  return {
    queries: queries.length ? queries : query ? [query] : [],
    recencyFilter: stringArg(args, 'recencyFilter'),
    domainCount: stringList(args, 'domainFilter').length,
    includeContent: recordArgs(args)?.includeContent === true,
  };
}

export type FetchContentPresentation = {
  urls: readonly string[];
};

export function fetchContentPresentation(
  args: unknown,
): FetchContentPresentation {
  const urls = stringList(args, 'urls');
  const url = stringArg(args, 'url');
  return { urls: urls.length ? urls : url ? [url] : [] };
}

export type GetSearchContentPresentation = {
  responseId?: string;
  view?: string;
  query?: string;
  queryIndex?: number;
  url?: string;
  urlIndex?: number;
  heading?: string;
  literal?: string;
};

export function getSearchContentPresentation(
  args: unknown,
): GetSearchContentPresentation {
  const record = recordArgs(args);
  const queryIndex = record?.queryIndex;
  const urlIndex = record?.urlIndex;
  return {
    responseId: stringArg(args, 'responseId'),
    view: stringArg(args, 'view'),
    query: stringArg(args, 'query'),
    queryIndex:
      typeof queryIndex === 'number' && Number.isFinite(queryIndex)
        ? queryIndex
        : undefined,
    url: stringArg(args, 'url'),
    urlIndex:
      typeof urlIndex === 'number' && Number.isFinite(urlIndex)
        ? urlIndex
        : undefined,
    heading: stringArg(args, 'heading'),
    literal: stringArg(args, 'literal'),
  };
}

export type DelegatePresentation = {
  name?: string;
  task?: string;
  route?: string;
  continuation?: string;
  taskCount: number;
};

export function delegatePresentation(args: unknown): DelegatePresentation {
  const tasks = recordArgs(args)?.tasks;
  return {
    name: stringArg(args, 'id') ?? stringArg(args, 'name'),
    task: stringArg(args, 'task'),
    route: stringArg(args, 'route'),
    continuation:
      stringArg(args, 'continue') ?? stringArg(args, 'continuation'),
    taskCount: Array.isArray(tasks) ? tasks.length : 0,
  };
}

export type ActionIdPresentation = {
  action?: string;
  id?: string;
  ids: readonly string[];
};

export function actionIdPresentation(args: unknown): ActionIdPresentation {
  return {
    action: stringArg(args, 'action'),
    id: stringArg(args, 'id'),
    ids: stringList(args, 'ids'),
  };
}

export type BackgroundPresentation = ActionIdPresentation & {
  title?: string;
  command?: string;
  /** Display-only target; IDs remain in the tool arguments and diagnostics. */
  target?: string;
  watches: readonly {
    contains: string;
    stream?: 'stdout' | 'stderr';
    timeoutSeconds?: number;
  }[];
  watchIds: readonly string[];
};

export function backgroundProcessTitles(
  result: unknown,
): ReadonlyMap<string, string> {
  const details = recordArgs(recordArgs(result)?.details);
  const processes = [
    details?.process,
    ...(Array.isArray(details?.processes) ? details.processes : []),
  ];
  const titles = new Map<string, string>();
  for (const process of processes) {
    const id = stringArg(process, 'id');
    const title = stringArg(process, 'title');
    if (id && title) titles.set(id, title);
  }
  return titles;
}

export function backgroundPresentation(
  args: unknown,
  result?: unknown,
  knownTitles: ReadonlyMap<string, string> = new Map(),
): BackgroundPresentation {
  const watch = recordArgs(args)?.watch;
  const action = actionIdPresentation(args);
  const titles = new Map([...knownTitles, ...backgroundProcessTitles(result)]);
  const targetIds = action.id ? [action.id] : action.ids;
  const fallback = 'Background process';
  const commandTitle = stringArg(args, 'command')
    ?.split(/[\r\n]/u, 1)[0]
    ?.replace(/\s+/gu, ' ')
    .slice(0, 80);
  const startedTitle = stringArg(
    recordArgs(recordArgs(result)?.details)?.process,
    'title',
  );
  const target =
    action.action === 'start'
      ? (startedTitle ?? stringArg(args, 'title') ?? commandTitle ?? fallback)
      : targetIds.length
        ? targetIds.map((id) => titles.get(id) ?? fallback).join(', ')
        : action.action === 'list'
          ? undefined
          : (stringArg(args, 'title') ?? fallback);
  return {
    target,
    ...action,
    title: stringArg(args, 'title'),
    command: stringArg(args, 'command'),
    watchIds: stringList(args, 'watch_ids'),
    watches: Array.isArray(watch)
      ? watch.flatMap((value) => {
          const entry = recordArgs(value);
          if (typeof entry?.contains !== 'string' || !entry.contains) return [];
          const stream =
            entry.stream === 'stdout' || entry.stream === 'stderr'
              ? entry.stream
              : undefined;
          const timeoutSeconds =
            typeof entry.timeout_seconds === 'number' &&
            Number.isFinite(entry.timeout_seconds) &&
            entry.timeout_seconds > 0
              ? entry.timeout_seconds
              : undefined;
          return [{ contains: entry.contains, stream, timeoutSeconds }];
        })
      : [],
  };
}

export type TodoOperationPresentation = {
  action?: string;
  id?: string;
  text?: string;
  notes?: string;
  status?: string;
  priority?: string;
  dependsOn: readonly string[];
  tasks: readonly TodoOperationPresentation[];
};

export type TodoPresentation = TodoOperationPresentation & {
  operations: readonly TodoOperationPresentation[];
  operationCount: number;
};

function todoItemPresentation(
  args: unknown,
  nested = false,
): TodoOperationPresentation {
  const record = recordArgs(args);
  return {
    action: stringArg(args, 'action') ?? stringArg(args, 'operation'),
    id: stringArg(args, 'id') ?? stringArg(args, 'taskId'),
    text: stringArg(args, 'text'),
    notes: stringArg(args, 'notes'),
    status: stringArg(args, 'status'),
    priority: stringArg(args, 'priority'),
    dependsOn: stringList(args, 'depends_on'),
    tasks:
      nested || !Array.isArray(record?.tasks)
        ? []
        : record.tasks.map((task) => todoItemPresentation(task, true)),
  };
}

function todoRestatedAction(operation: TodoOperationPresentation): string {
  return [operation.action, operation.id]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function todoReplacedResult(taskCount: number): string {
  return `replaced with ${taskCount} tasks`;
}

export function todoPresentation(args: unknown): TodoPresentation {
  const operationsRaw = recordArgs(args)?.operations;
  const operations = Array.isArray(operationsRaw)
    ? operationsRaw.map((operation) => todoItemPresentation(operation))
    : [];
  return {
    ...todoItemPresentation(args),
    operations,
    operationCount: operations.length,
  };
}

/** True when the tool result is only restating action + id already in the header. */
export function todoResultIsRedundant(
  args: unknown,
  resultText: string,
): boolean {
  const model = todoPresentation(args);
  const compact = resultText.replace(/\s+/gu, ' ').trim().toLowerCase();
  if (!compact) return true;
  if (!model.operations.length && model.tasks.length)
    return compact === todoReplacedResult(model.tasks.length);
  const restated = model.operations.length
    ? model.operations.map(todoRestatedAction).join('; ')
    : todoRestatedAction(model);
  return compact === restated;
}

export type DelegateChangesPresentation = ActionIdPresentation & {
  scope?: string;
  incremental: boolean;
  summaryOnly: boolean;
  paths: readonly string[];
  patchBudget?: number;
};

export function delegateChangesPresentation(
  args: unknown,
): DelegateChangesPresentation {
  const record = recordArgs(args);
  const patchBudget = record?.patchBudget;
  return {
    ...actionIdPresentation(args),
    id: stringArg(args, 'node') ?? stringArg(args, 'id'),
    scope: stringArg(args, 'scope'),
    incremental: record?.incremental === true,
    summaryOnly: record?.summaryOnly === true,
    paths: stringList(args, 'paths'),
    patchBudget:
      typeof patchBudget === 'number' && Number.isFinite(patchBudget)
        ? patchBudget
        : undefined,
  };
}

export type DelegateGatePresentation = {
  mode?: 'all' | 'any';
  references: readonly string[];
  delivery?: string;
};

export function delegateGatePresentation(
  args: unknown,
): DelegateGatePresentation {
  const all = stringList(args, 'all');
  const any = stringList(args, 'any');
  return {
    mode: all.length ? 'all' : any.length ? 'any' : undefined,
    references: all.length ? all : any,
    delivery: stringArg(args, 'delivery'),
  };
}
