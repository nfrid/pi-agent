import {
  type TranscriptEntry as ActivityTranscriptEntry,
  projectActivityGroups,
} from '@pi-dashboard/activity-model';
import { dashboardHttpClient } from '@pi-dashboard/client';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import {
  type Dispatch,
  type SetStateAction,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { Markdown } from '../Markdown';
import {
  isNarration,
  type TranscriptModelItem,
  toolOutcome,
  toolRecordForTranscript,
  toolSummary,
  toTranscriptEntries,
} from '../transcript';

export function preserveVirtualScrollOffset(
  previousTop: number,
  nextTop: number,
  bottomStuck: boolean,
): number {
  return bottomStuck ? 0 : previousTop - nextTop;
}

export function restoreVirtualBottom(
  scrollHeight: number,
  viewportHeight: number,
  bottomStuck: boolean,
): number | undefined {
  return bottomStuck ? Math.max(0, scrollHeight - viewportHeight) : undefined;
}

function isNearPageBottom(
  scrollHeight: number,
  scrollY: number,
  innerHeight: number,
  threshold = 120,
): boolean {
  return scrollHeight - scrollY - innerHeight <= threshold;
}

function activityTitleLine(text: string): string {
  return (
    text
      .split('\n')[0]
      ?.trim()
      .replace(/[.…:]+$/, '') ?? text
  );
}

export function shouldShowActivityLead(text: string, title: string): boolean {
  return !isNarration(text) && activityTitleLine(text) !== title;
}

function invokeActivityExpansion(
  runtime: RuntimeSnapshot | undefined,
  expanded: boolean,
): void {
  const actionId = 'activity-groups.set';
  const advertised = runtime?.capabilities?.manifests.some((manifest) =>
    manifest.actions.some((action) => action.id === actionId),
  );
  if (!runtime || !advertised || runtime.online === false) return;
  void dashboardHttpClient
    .invokeAction(runtime.runtimeId, actionId, { expanded })
    .catch(() => undefined);
}

export function Transcript({
  entries,
  runtime,
}: {
  entries: unknown[];
  runtime?: RuntimeSnapshot;
}) {
  const items = useMemo(() => toTranscriptEntries(entries), [entries]);
  const modelEntries = useMemo(() => items.map((item) => item.entry), [items]);
  const groups = useMemo(
    () => projectActivityGroups(modelEntries),
    [modelEntries],
  );
  const [open, setOpen] = useState<Set<string>>(new Set());
  const groupByStart = new Map(groups.map((group) => [group.start, group]));
  if (items.length > 80)
    return (
      <VirtualizedTranscript
        items={items}
        modelEntries={modelEntries}
        groups={groups}
        open={open}
        setOpen={setOpen}
        runtime={runtime}
      />
    );
  return (
    <div className="transcript">
      <h2>Conversation &amp; activity</h2>
      {items.map((item, index) => {
        const group = groupByStart.get(index);
        if (group) {
          const groupKey = items[group.start]?.key ?? 'unknown-group';
          const expanded = open.has(groupKey);
          const tools = modelEntries
            .slice(group.start, group.end + 1)
            .filter(
              (
                entry,
              ): entry is Extract<ActivityTranscriptEntry, { kind: 'tool' }> =>
                entry.kind === 'tool',
            );
          const groupItems = items.slice(group.start, group.end + 1);
          const preparing = groupItems.some((item) => item.preparing);
          const complete =
            !preparing &&
            tools.length > 0 &&
            groupItems
              .filter((item) => item.entry.kind === 'tool')
              .every((item) => toolOutcome(item.raw) === 'success');
          const title = group.title;
          const lead = items[group.start];
          const visibleLead =
            !lead?.preparing &&
            lead?.role === 'assistant' &&
            lead.text &&
            shouldShowActivityLead(lead.text, title)
              ? lead.text
              : undefined;
          const detailId = `activity-detail-${group.start}`;
          return (
            <div
              className={`activity-group ${complete ? 'activity-complete' : 'activity-pending'}`}
              key={`group-${groupKey}`}
            >
              <AriaButton
                type="button"
                aria-expanded={expanded}
                aria-controls={detailId}
                onPress={() => {
                  const nextExpanded = !expanded;
                  setOpen((current) => {
                    const next = new Set(current);
                    nextExpanded ? next.add(groupKey) : next.delete(groupKey);
                    return next;
                  });
                  invokeActivityExpansion(runtime, nextExpanded);
                }}
              >
                <span className="activity-icon">{complete ? '✓' : '…'}</span>
                <strong>{title}</strong>
                <small>
                  {preparing
                    ? tools.length > 0
                      ? `${tools.length} tool${tools.length === 1 ? '' : 's'} · preparing next tool call`
                      : 'preparing tool call'
                    : `${tools.length} tool${tools.length === 1 ? '' : 's'} · ${expanded ? 'hide detail' : 'show detail'}`}
                </small>
              </AriaButton>
              {visibleLead && (
                <div className="activity-lead">
                  <span className="message-role">assistant</span>
                  <Markdown>{visibleLead}</Markdown>
                </div>
              )}
              {expanded && (
                <div className="activity-detail" id={detailId}>
                  {groupItems.map((child) => (
                    <TranscriptEntry key={child.key} item={child} />
                  ))}
                </div>
              )}
            </div>
          );
        }
        if (
          groups.some(
            (candidate) => index > candidate.start && index <= candidate.end,
          )
        )
          return null;
        return <TranscriptEntry key={item.key} item={item} />;
      })}
    </div>
  );
}

type TranscriptGroup = ReturnType<typeof projectActivityGroups>[number];

type VirtualTranscriptRow =
  | { kind: 'entry'; key: string; index: number }
  | { kind: 'group'; key: string; group: TranscriptGroup };

function VirtualizedTranscript({
  items,
  modelEntries,
  groups,
  open,
  setOpen,
  runtime,
}: {
  items: readonly TranscriptModelItem[];
  modelEntries: readonly ActivityTranscriptEntry[];
  groups: readonly TranscriptGroup[];
  open: ReadonlySet<string>;
  setOpen: Dispatch<SetStateAction<Set<string>>>;
  runtime?: RuntimeSnapshot;
}) {
  const groupByStart = useMemo(
    () => new Map(groups.map((group) => [group.start, group])),
    [groups],
  );
  const rows = useMemo<VirtualTranscriptRow[]>(() => {
    const result: VirtualTranscriptRow[] = [];
    items.forEach((item, index) => {
      const group = groupByStart.get(index);
      if (group) {
        const groupKey = items[group.start]?.key ?? `group-${group.start}`;
        result.push({ kind: 'group', key: `group-${groupKey}`, group });
      } else if (
        !groups.some(
          (candidate) => index > candidate.start && index <= candidate.end,
        )
      )
        result.push({ kind: 'entry', key: item.key, index });
    });
    return result;
  }, [groupByStart, groups, items]);
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: (index) => (rows[index]?.kind === 'group' ? 132 : 96),
    overscan: 8,
    getItemKey: (index) => rows[index]?.key ?? `transcript-row-${index}`,
    measureElement: (element) => element.getBoundingClientRect().height,
  });
  const anchorRef = useRef<{ key: string; top: number } | undefined>(undefined);
  const bottomStuckRef = useRef(false);
  const captureScrollAnchor = (key: string) => {
    const bottomStuck = isNearPageBottom(
      document.documentElement.scrollHeight,
      window.scrollY,
      window.innerHeight,
    );
    bottomStuckRef.current = bottomStuck;
    if (bottomStuck) {
      anchorRef.current = undefined;
      return;
    }
    const element = Array.from(
      document.querySelectorAll<HTMLElement>('[data-transcript-row]'),
    ).find((candidate) => candidate.dataset.transcriptRow === key);
    if (element)
      anchorRef.current = { key, top: element.getBoundingClientRect().top };
  };
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const bottomStuck = bottomStuckRef.current;
    if (!anchor && !bottomStuck) return;
    let measuredFrame: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      measuredFrame = window.requestAnimationFrame(() => {
        if (bottomStuck) {
          const top = restoreVirtualBottom(
            document.documentElement.scrollHeight,
            window.innerHeight,
            true,
          );
          if (top !== undefined) window.scrollTo(0, top);
        } else if (anchor) {
          const element = Array.from(
            document.querySelectorAll<HTMLElement>('[data-transcript-row]'),
          ).find((candidate) => candidate.dataset.transcriptRow === anchor.key);
          if (element)
            window.scrollBy({
              top: preserveVirtualScrollOffset(
                anchor.top,
                element.getBoundingClientRect().top,
                false,
              ),
              left: 0,
            });
        }
        anchorRef.current = undefined;
        bottomStuckRef.current = false;
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (measuredFrame !== undefined)
        window.cancelAnimationFrame(measuredFrame);
    };
  });

  const renderGroup = (group: TranscriptGroup) => {
    const groupKey = items[group.start]?.key ?? `group-${group.start}`;
    const expanded = open.has(groupKey);
    const groupItems = items.slice(group.start, group.end + 1);
    const tools = modelEntries
      .slice(group.start, group.end + 1)
      .filter(
        (entry): entry is Extract<ActivityTranscriptEntry, { kind: 'tool' }> =>
          entry.kind === 'tool',
      );
    const preparing = groupItems.some((item) => item.preparing);
    const complete =
      !preparing &&
      tools.length > 0 &&
      groupItems
        .filter((item) => item.entry.kind === 'tool')
        .every((item) => toolOutcome(item.raw) === 'success');
    const title = group.title;
    const lead = items[group.start];
    const visibleLead =
      !lead?.preparing &&
      lead?.role === 'assistant' &&
      lead.text &&
      shouldShowActivityLead(lead.text, title)
        ? lead.text
        : undefined;
    const detailId = `activity-detail-${group.start}`;
    return (
      <div
        className={`activity-group ${complete ? 'activity-complete' : 'activity-pending'}`}
      >
        <AriaButton
          type="button"
          aria-expanded={expanded}
          aria-controls={detailId}
          onPress={() => {
            captureScrollAnchor(`group-${groupKey}`);
            const nextExpanded = !expanded;
            setOpen((current) => {
              const next = new Set(current);
              nextExpanded ? next.add(groupKey) : next.delete(groupKey);
              return next;
            });
            invokeActivityExpansion(runtime, nextExpanded);
          }}
        >
          <span className="activity-icon">{complete ? '✓' : '…'}</span>
          <strong>{title}</strong>
          <small>
            {preparing
              ? tools.length > 0
                ? `${tools.length} tool${tools.length === 1 ? '' : 's'} · preparing next tool call`
                : 'preparing tool call'
              : `${tools.length} tool${tools.length === 1 ? '' : 's'} · ${expanded ? 'hide detail' : 'show detail'}`}
          </small>
        </AriaButton>
        {visibleLead && (
          <div className="activity-lead">
            <span className="message-role">assistant</span>
            <Markdown>{visibleLead}</Markdown>
          </div>
        )}
        {expanded && (
          <div className="activity-detail" id={detailId}>
            {groupItems.map((child) => (
              <TranscriptEntry key={child.key} item={child} />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="transcript transcript-virtualized">
      <h2>Conversation &amp; activity</h2>
      <div
        className="transcript-virtualizer"
        style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              data-transcript-row={row.key}
              ref={virtualizer.measureElement}
              className="transcript-virtual-row"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {row.kind === 'group' ? (
                renderGroup(row.group)
              ) : (
                <TranscriptEntry item={items[row.index]} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const INSPECTOR_MAX_TEXT = 1_200;
const INSPECTOR_MAX_DEPTH = 3;
const INSPECTOR_MAX_KEYS = 16;

export function boundedInspectorText(value: unknown, depth = 0): string {
  if (depth >= INSPECTOR_MAX_DEPTH) return '…';
  if (typeof value === 'string') return value.slice(0, INSPECTOR_MAX_TEXT);
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (Array.isArray(value))
    return `[${value
      .slice(0, INSPECTOR_MAX_KEYS)
      .map((item) => boundedInspectorText(item, depth + 1))
      .join(', ')}${value.length > INSPECTOR_MAX_KEYS ? ', …' : ''}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      INSPECTOR_MAX_KEYS,
    );
    return `{ ${entries
      .map(([key, item]) => `${key}: ${boundedInspectorText(item, depth + 1)}`)
      .join(
        ', ',
      )}${Object.keys(value as Record<string, unknown>).length > INSPECTOR_MAX_KEYS ? ', …' : ''} }`;
  }
  return String(value);
}

export function toolInspectorRows(
  tool: Record<string, unknown>,
): Array<[string, unknown]> {
  const rows: Array<[string, unknown]> = [
    ['status', tool.status ?? (tool.isError ? 'error' : 'pending')],
    ['arguments', tool.arguments ?? tool.args],
    ['result', tool.result],
  ];
  return rows.filter(([, value]) => value !== undefined);
}

function ToolInspector({ tool }: { tool: Record<string, unknown> }) {
  let rawText = '[unavailable tool payload]';
  try {
    rawText = JSON.stringify(tool, null, 2) ?? rawText;
  } catch {
    // Opaque provider values must never break the transcript inspector.
  }
  return (
    <div className="tool-inspector">
      <dl>
        {toolInspectorRows(tool).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{boundedInspectorText(value)}</dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>Raw payload</summary>
        <pre>{rawText.slice(0, 12_000)}</pre>
      </details>
    </div>
  );
}

function TranscriptEntry({
  item,
}: {
  item: import('../transcript').TranscriptModelItem;
}) {
  if (item.preparing)
    return (
      <div className="transcript-entry preparing-toolcall" role="status">
        <span className="activity-icon">…</span>
        <strong>
          {item.text ? activityTitleLine(item.text) : 'Preparing tool call'}
        </strong>
        <small>preparing tool call</small>
      </div>
    );
  if (item.role && (item.text || item.imageCount))
    return (
      <article className={`message-bubble message-${item.role}`}>
        <span className="message-role">{item.role}</span>
        {item.imageCount ? (
          <span className="message-attachment">
            {item.imageCount} image{item.imageCount === 1 ? '' : 's'} attached
          </span>
        ) : null}
        {item.text ? <Markdown>{item.text}</Markdown> : null}
      </article>
    );
  const raw = item.raw;
  const tool = toolRecordForTranscript(raw);
  if (tool) {
    const name =
      typeof tool.name === 'string'
        ? tool.name
        : typeof tool.toolName === 'string'
          ? tool.toolName
          : 'tool';
    return (
      <details className="transcript-entry tool-detail">
        <summary>
          <span className="tool-chip">{name}</span>
          <span>{toolSummary(tool)}</span>
        </summary>
        <ToolInspector tool={tool} />
      </details>
    );
  }
  const text = JSON.stringify(raw, null, 2);
  return (
    <details className="transcript-entry">
      <summary>
        {typeof raw === 'object' && raw && 'type' in raw
          ? String((raw as { type?: unknown }).type)
          : 'entry'}
      </summary>
      <pre>{text}</pre>
    </details>
  );
}

export { activityTitleLine };
