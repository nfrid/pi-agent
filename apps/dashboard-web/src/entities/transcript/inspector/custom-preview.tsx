import {
  actionIdPresentation,
  backgroundPresentation,
  type CustomToolKind,
  delegateBranchesPresentation,
  delegatePresentation,
  fetchContentPresentation,
  getSearchContentPresentation,
  type TodoOperationPresentation,
  todoPresentation,
  todoResultIsRedundant,
  webSearchPresentation,
} from '@pi-dashboard/activity-model';
import type { ReactNode } from 'react';
import { Markdown } from '../../../Markdown';
import { PreviewTruncation, sourceTruncated } from './truncation';
import type { ToolRecord } from './types';

function compact(value: string, max = 220): string {
  const compactValue = value.replace(/\s+/gu, ' ').trim();
  return compactValue.length > max
    ? `${compactValue.slice(0, max - 1)}…`
    : compactValue;
}

function Summary({ title, detail }: { title: string; detail?: string }) {
  return (
    <p className="tool-custom-summary">
      <strong>{title}</strong>
      {detail ? <small>{` · ${detail}`}</small> : null}
    </p>
  );
}

function resultDetails(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const details = (value as Record<string, unknown>).details;
  return details && typeof details === 'object' && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : undefined;
}

function finiteResultNumber(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'number' &&
    Number.isFinite(candidate) &&
    candidate >= 0
    ? candidate
    : undefined;
}

/** Outcome fields have to be named facts from the extension result contract. */
function customOutcomeFacts(kind: CustomToolKind, result: unknown): string[] {
  const details = resultDetails(result);
  if (!details) return [];
  if (kind === 'web_search') {
    const queries = finiteResultNumber(details, 'queryCount');
    const failed = finiteResultNumber(details, 'failed');
    return [
      queries === undefined
        ? undefined
        : `${queries} quer${queries === 1 ? 'y' : 'ies'}`,
      failed === undefined || failed === 0 ? undefined : `${failed} failed`,
    ].filter((fact): fact is string => Boolean(fact));
  }
  if (kind === 'fetch_content') {
    const pages = finiteResultNumber(details, 'urlCount');
    const successful = finiteResultNumber(details, 'successful');
    const chars = finiteResultNumber(details, 'totalChars');
    return [
      pages === undefined
        ? undefined
        : `${pages} page${pages === 1 ? '' : 's'}`,
      successful !== undefined && pages !== undefined && successful < pages
        ? `${successful} succeeded`
        : undefined,
      chars === undefined ? undefined : `${chars.toLocaleString()} chars`,
    ].filter((fact): fact is string => Boolean(fact));
  }
  if (kind === 'get_search_content') {
    const chars = finiteResultNumber(details, 'selectedChars');
    return chars === undefined ? [] : [`${chars.toLocaleString()} chars`];
  }
  if (kind === 'background') {
    const process =
      details.process &&
      typeof details.process === 'object' &&
      !Array.isArray(details.process)
        ? (details.process as Record<string, unknown>)
        : undefined;
    const processes = Array.isArray(details.processes)
      ? details.processes.filter(
          (value): value is Record<string, unknown> =>
            Boolean(value) &&
            typeof value === 'object' &&
            !Array.isArray(value),
        )
      : [];
    if (process) {
      const status =
        typeof process.status === 'string' ? process.status : undefined;
      const exitCode =
        typeof process.exitCode === 'number' &&
        Number.isFinite(process.exitCode)
          ? process.exitCode
          : undefined;
      return [
        status,
        exitCode === undefined ? undefined : `exit ${exitCode}`,
      ].filter((fact): fact is string => Boolean(fact));
    }
    if (processes.length > 0) {
      const statusCounts = new Map<string, number>();
      for (const item of processes) {
        if (typeof item.status === 'string')
          statusCounts.set(
            item.status,
            (statusCounts.get(item.status) ?? 0) + 1,
          );
      }
      return [
        `${processes.length} process${processes.length === 1 ? '' : 'es'}`,
        ...[...statusCounts].map(([status, count]) => `${count} ${status}`),
      ];
    }
  }
  return [];
}

function OutcomeFacts({
  kind,
  result,
}: {
  kind: CustomToolKind;
  result: unknown;
}) {
  const facts = customOutcomeFacts(kind, result);
  return facts.length ? (
    <small className="tool-custom-outcome">{facts.join(' · ')}</small>
  ) : null;
}

function ResultBody({
  kind,
  text,
  truncated,
  sourceTruncated: isSourceTruncated,
}: {
  kind: CustomToolKind;
  text: string;
  truncated: boolean;
  sourceTruncated: boolean;
}) {
  const markdown =
    kind === 'web_search' ||
    kind === 'fetch_content' ||
    kind === 'get_search_content' ||
    kind === 'delegate';
  return (
    <>
      {markdown ? (
        <div className="tool-markdown-result">
          <Markdown>{text}</Markdown>
        </div>
      ) : (
        <pre className="tool-terminal-output tool-custom-output">{text}</pre>
      )}
      <PreviewTruncation
        label="Result"
        sourceTruncated={isSourceTruncated}
        textTruncated={truncated}
      />
    </>
  );
}

function WebSearchSummary({ args }: { args: unknown }) {
  const model = webSearchPresentation(args);
  const extras = [
    model.recencyFilter,
    model.domainCount
      ? `${model.domainCount} domain filter${model.domainCount === 1 ? '' : 's'}`
      : undefined,
    model.includeContent ? 'with page text' : undefined,
  ].filter(Boolean);
  const detail =
    model.queries.length === 1
      ? compact(model.queries[0] ?? '')
      : model.queries.length
        ? `${model.queries.length} queries`
        : extras.length
          ? extras.join(' · ')
          : undefined;
  return (
    <>
      <Summary detail={detail} title="Web search" />
      {model.queries.length > 1 ? (
        <ul className="tool-custom-list">
          {model.queries.map((query) => (
            <li key={query}>{compact(query, 160)}</li>
          ))}
        </ul>
      ) : null}
      {model.queries.length === 1 && extras.length ? (
        <small className="tool-custom-meta">{extras.join(' · ')}</small>
      ) : null}
    </>
  );
}

function FetchSummary({ args }: { args: unknown }) {
  const { urls } = fetchContentPresentation(args);
  return (
    <>
      <Summary
        detail={
          urls.length === 1
            ? compact(urls[0] ?? '', 160)
            : urls.length
              ? `${urls.length} pages`
              : undefined
        }
        title="Fetch"
      />
      {urls.length > 1 ? (
        <ul className="tool-custom-list">
          {urls.map((url) => (
            <li key={url}>{compact(url, 160)}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function GetSearchContentSummary({ args }: { args: unknown }) {
  const model = getSearchContentPresentation(args);
  const selectors = [
    model.view,
    model.query ? compact(model.query, 80) : undefined,
    model.queryIndex !== undefined
      ? `query ${model.queryIndex + 1}`
      : undefined,
    model.url ? compact(model.url, 80) : undefined,
    model.urlIndex !== undefined ? `page ${model.urlIndex + 1}` : undefined,
    model.heading ? compact(model.heading, 80) : undefined,
    model.literal ? compact(model.literal, 80) : undefined,
  ].filter(Boolean);
  return (
    <Summary
      detail={[model.responseId, ...selectors].filter(Boolean).join(' · ')}
      title="Search content"
    />
  );
}

function DelegateSummary({ args }: { args: unknown }) {
  const model = delegatePresentation(args);
  const detail = [
    model.name,
    model.route,
    model.continuation ? 'continuation' : undefined,
    !model.name && model.taskCount
      ? `${model.taskCount} task${model.taskCount === 1 ? '' : 's'}`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <Summary detail={detail || undefined} title="Delegate" />
      {model.task ? (
        <p className="tool-custom-task">{compact(model.task, 360)}</p>
      ) : null}
    </>
  );
}

function BranchesSummary({ args }: { args: unknown }) {
  const model = delegateBranchesPresentation(args);
  const target =
    model.id ??
    (model.ids.length === 1
      ? model.ids[0]
      : model.ids.length
        ? `${model.ids.length} ids`
        : undefined);
  const selectors = [
    model.scope === 'all' ? 'all history' : undefined,
    model.incremental ? 'incremental' : undefined,
    model.summaryOnly ? 'summary' : undefined,
    model.paths.length
      ? `${model.paths.length} path${model.paths.length === 1 ? '' : 's'}`
      : undefined,
    model.patchBudget !== undefined
      ? `${model.patchBudget.toLocaleString()} char budget`
      : undefined,
  ].filter(Boolean);
  return (
    <>
      <Summary
        detail={[model.action ?? 'list', target, ...selectors]
          .filter(Boolean)
          .join(' · ')}
        title="Delegate branches"
      />
      {model.paths.length > 0 ? (
        <ul className="tool-custom-list">
          {model.paths.map((path) => (
            <li key={path}>{compact(path, 160)}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function ActionSummary({
  title,
  args,
  fallback = 'list',
}: {
  title: string;
  args: unknown;
  fallback?: string;
}) {
  const model = actionIdPresentation(args);
  const target =
    model.id ??
    (model.ids.length === 1
      ? model.ids[0]
      : model.ids.length
        ? `${model.ids.length} ids`
        : undefined);
  return (
    <Summary
      detail={[model.action ?? fallback, target].filter(Boolean).join(' · ')}
      title={title}
    />
  );
}

function BackgroundSummary({ args }: { args: unknown }) {
  const model = backgroundPresentation(args);
  const detail = [model.action ?? 'list', model.title ?? model.id]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <Summary detail={detail} title="Background" />
      {model.command ? (
        <pre className="tool-code-preview tool-command-preview">
          {model.command}
        </pre>
      ) : null}
    </>
  );
}

function todoDetail(model: TodoOperationPresentation): string {
  return [model.action, model.id, model.status, model.priority]
    .filter(Boolean)
    .join(' · ');
}

function TodoFields({
  dependsOn,
  notes,
  text,
}: Pick<TodoOperationPresentation, 'dependsOn' | 'notes' | 'text'>) {
  return (
    <>
      {text ? <p className="tool-custom-task">{compact(text, 360)}</p> : null}
      {notes ? (
        <p className="tool-custom-notes">{compact(notes, 360)}</p>
      ) : null}
      {dependsOn.length ? (
        <small className="tool-custom-meta">
          depends on {dependsOn.join(', ')}
        </small>
      ) : null}
    </>
  );
}

function todoOperationKey(operation: TodoOperationPresentation): string {
  return [
    operation.action ?? 'op',
    operation.id,
    operation.status,
    operation.priority,
    operation.text,
    operation.notes,
    operation.dependsOn.join(','),
    operation.tasks.map((task) => task.id ?? '').join(','),
  ]
    .filter(Boolean)
    .join('\0');
}

function TodoItemList({
  items,
  noun,
}: {
  items: readonly TodoOperationPresentation[];
  noun: 'operation' | 'task';
}) {
  return (
    <ul
      aria-label={
        noun === 'operation' ? 'Task operations' : 'Replacement tasks'
      }
      className="tool-custom-list tool-todo-operations"
    >
      {items.map((item) => (
        <li key={todoOperationKey(item)}>
          <strong>{todoDetail(item) || noun}</strong>
          <TodoFields {...item} />
          {item.tasks.length > 0 ? (
            <TodoItemList items={item.tasks} noun="task" />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function TodoSummary({ args }: { args: unknown }) {
  const model = todoPresentation(args);
  const items = model.operations.length ? model.operations : model.tasks;
  const noun = model.operations.length ? 'operation' : 'task';
  const listed = items.length > 0;
  const detail = [
    model.action ?? 'update',
    listed ? undefined : model.id,
    listed ? undefined : model.status,
    listed ? undefined : model.priority,
    listed
      ? `${items.length} ${noun}${items.length === 1 ? '' : 's'}`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <Summary detail={detail} title="Tasks" />
      {listed ? (
        <TodoItemList items={items} noun={noun} />
      ) : (
        <TodoFields {...model} />
      )}
    </>
  );
}

const SUMMARIES: Record<CustomToolKind, (args: unknown) => ReactNode> = {
  web_search: (args) => <WebSearchSummary args={args} />,
  fetch_content: (args) => <FetchSummary args={args} />,
  get_search_content: (args) => <GetSearchContentSummary args={args} />,
  delegate: (args) => <DelegateSummary args={args} />,
  delegate_jobs: (args) => <ActionSummary args={args} title="Delegate jobs" />,
  delegate_branches: (args) => <BranchesSummary args={args} />,
  delegate_wake: (args) => <ActionSummary args={args} title="Delegate wake" />,
  background: (args) => <BackgroundSummary args={args} />,
  todo: (args) => <TodoSummary args={args} />,
};

export function CustomToolInspector({
  kind,
  tool,
  result,
}: {
  kind: CustomToolKind;
  tool: ToolRecord;
  result?: { text: string; truncated: boolean };
}) {
  const args = tool.arguments ?? tool.args;
  const visibleResult =
    result && !(kind === 'todo' && todoResultIsRedundant(args, result.text))
      ? result
      : undefined;
  return (
    <section
      className={`payload-section tool-specialized tool-${kind}-presentation`}
      aria-label={`${kind} presentation`}
    >
      {SUMMARIES[kind](args)}
      <OutcomeFacts kind={kind} result={tool.result} />
      {visibleResult ? (
        <ResultBody
          kind={kind}
          sourceTruncated={sourceTruncated(tool, 'result')}
          text={visibleResult.text}
          truncated={visibleResult.truncated}
        />
      ) : (
        <PreviewTruncation
          label="Result"
          sourceTruncated={sourceTruncated(tool, 'result')}
          textTruncated={false}
        />
      )}
    </section>
  );
}
