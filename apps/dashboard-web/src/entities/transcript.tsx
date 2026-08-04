import { projectActivityGroups } from '@pi-dashboard/activity-model';
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
    () =>
      projectActivityGroups(modelEntries, {
        // Historical groups stay complete; only the transcript tail inherits
        // activity from the runtime when a live tool status is not available.
        liveTail:
          runtime?.online !== false &&
          (runtime?.liveState === 'working' ||
            runtime?.liveState === 'waiting' ||
            runtime?.liveState === 'aborting' ||
            runtime?.liveState === 'stopping'),
      }),
    [modelEntries, runtime],
  );
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { groupByStart, groupCoverage } = useMemo(
    () => buildTranscriptGroupCoverage(items.length, groups),
    [groups, items.length],
  );
  if (items.length > 80)
    return (
      <VirtualizedTranscript
        items={items}
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
          const presentation = activityGroupPresentation(group, expanded);
          const groupItems = items.slice(group.start, group.end + 1);
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
              className={`activity-group ${presentation.className}`}
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
                <span className="activity-icon">{presentation.icon}</span>
                <strong>{title}</strong>
                <small>{presentation.label}</small>
              </AriaButton>
              {!expanded && <CollapsedActivitySummary group={group} />}
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
        if (groupCoverage[index]) return null;
        return <TranscriptEntry key={item.key} item={item} />;
      })}
    </div>
  );
}

export type TranscriptGroup = ReturnType<typeof projectActivityGroups>[number];

export type ActivityGroupSummary = {
  recentTools: readonly string[];
  earlierToolCount: number;
  toolCount: number;
  failureCount: number;
};

type ActivityGroupSummaryInput = Pick<TranscriptGroup, 'tools' | 'toolCount'>;

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
      `${summary.failureCount} failure${summary.failureCount === 1 ? '' : 's'}`,
    );
  return parts.join(' · ');
}

function CollapsedActivitySummary({ group }: { group: TranscriptGroup }) {
  const summary = activityGroupSummary(group);
  const stepKeyCounts = new Map<string, number>();
  return (
    <div className="activity-summary">
      {summary.earlierToolCount > 0 && (
        <span className="activity-earlier">
          ⋮ {summary.earlierToolCount} earlier step
          {summary.earlierToolCount === 1 ? '' : 's'}
        </span>
      )}
      {summary.recentTools.length > 0 && (
        <ol className="activity-steps">
          {summary.recentTools.map((name) => {
            const occurrence = (stepKeyCounts.get(name) ?? 0) + 1;
            stepKeyCounts.set(name, occurrence);
            return (
              <li key={`${name}-${occurrence}`}>
                <span aria-hidden="true">⏺</span> {name}
              </li>
            );
          })}
        </ol>
      )}
      <small className="activity-metadata">
        {activityGroupMetadata(summary)}
      </small>
    </div>
  );
}

export function buildTranscriptGroupCoverage(
  itemCount: number,
  groups: readonly TranscriptGroup[],
): {
  groupByStart: Map<number, TranscriptGroup>;
  groupCoverage: Uint8Array;
} {
  const groupByStart = new Map<number, TranscriptGroup>();
  const groupCoverage = new Uint8Array(itemCount);
  let groupIndex = 0;
  for (let index = 0; index < itemCount; index += 1) {
    while (groupIndex < groups.length) {
      const candidate = groups[groupIndex];
      if (!candidate || candidate.end >= index) break;
      groupIndex += 1;
    }
    const group = groups[groupIndex];
    if (!group) continue;
    groupByStart.set(group.start, group);
    if (group.start <= index && index <= group.end) groupCoverage[index] = 1;
  }
  // A group can start beyond the last item only for malformed external input;
  // retain the start map without letting it affect the coverage scan.
  for (const group of groups)
    if (!groupByStart.has(group.start)) groupByStart.set(group.start, group);
  return { groupByStart, groupCoverage };
}

export type VirtualTranscriptRow =
  | { kind: 'entry'; key: string; index: number }
  | { kind: 'group'; key: string; group: TranscriptGroup };

export type VirtualTranscriptRowBuildStats = { groupReads: number };

/**
 * Collapse covered transcript entries into group rows with a single sorted group
 * pointer. Callers must provide valid, sorted, disjoint ranges (the direct
 * output of groupTranscript); under that assumption this is O(items + groups),
 * not a groups.some scan for every item.
 */
export function buildVirtualTranscriptRows(
  items: readonly Pick<TranscriptModelItem, 'key'>[],
  groups: readonly TranscriptGroup[],
  stats?: VirtualTranscriptRowBuildStats,
): VirtualTranscriptRow[] {
  const result: VirtualTranscriptRow[] = [];
  let groupIndex = 0;
  for (let index = 0; index < items.length; index += 1) {
    while (groupIndex < groups.length) {
      if (stats) stats.groupReads += 1;
      const candidate = groups[groupIndex];
      if (!candidate || candidate.end >= index) break;
      groupIndex += 1;
    }
    const group = groups[groupIndex];
    if (stats) stats.groupReads += 1;
    if (group?.start === index) {
      const groupKey = items[group.start]?.key ?? `group-${group.start}`;
      result.push({ kind: 'group', key: `group-${groupKey}`, group });
    } else if (!group || index <= group.start || index > group.end) {
      result.push({
        kind: 'entry',
        key: items[index]?.key ?? `entry-${index}`,
        index,
      });
    }
  }
  return result;
}

export function activityGroupPresentation(
  group: Pick<TranscriptGroup, 'status' | 'toolCount'>,
  expanded: boolean,
): {
  className: 'activity-complete' | 'activity-pending' | 'activity-failed';
  icon: '✓' | '…' | '!';
  label: string;
  status: TranscriptGroup['status'];
} {
  const detail = expanded ? 'hide detail' : 'show detail';
  const count = `${group.toolCount} tool${group.toolCount === 1 ? '' : 's'}`;
  if (group.status === 'failed')
    return {
      className: 'activity-failed',
      icon: '!',
      label: `${count} · failed · ${detail}`,
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
      label: `${count} · in progress · ${detail}`,
      status: group.status,
    };
  return {
    className: 'activity-complete',
    icon: '✓',
    label: `${count} · ${detail}`,
    status: group.status,
  };
}

function VirtualizedTranscript({
  items,
  groups,
  open,
  setOpen,
  runtime,
}: {
  items: readonly TranscriptModelItem[];
  groups: readonly TranscriptGroup[];
  open: ReadonlySet<string>;
  setOpen: Dispatch<SetStateAction<Set<string>>>;
  runtime?: RuntimeSnapshot;
}) {
  const rows = useMemo(
    () => buildVirtualTranscriptRows(items, groups),
    [groups, items],
  );
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
    const presentation = activityGroupPresentation(group, expanded);
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
      <div className={`activity-group ${presentation.className}`}>
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
          <span className="activity-icon">{presentation.icon}</span>
          <strong>{title}</strong>
          <small>{presentation.label}</small>
        </AriaButton>
        {!expanded && <CollapsedActivitySummary group={group} />}
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
