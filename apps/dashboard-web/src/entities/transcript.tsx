import {
  projectActivityGroups,
  toolActionSummary,
  toolBaseName,
} from '@pi-dashboard/activity-model';
import { dashboardHttpClient } from '@pi-dashboard/client';
import type {
  TranscriptProjection,
  TranscriptRenderToolItem,
} from '@pi-dashboard/domain';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import {
  type Dispatch,
  type SetStateAction,
  useEffect,
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

export type TranscriptLandmark = {
  key: string;
  label: string;
  kind: 'user' | 'assistant' | 'activity';
  itemIndex: number;
};

function landmarkLabel(item: TranscriptModelItem, fallback: string): string {
  const text = item.text?.replace(/\s+/gu, ' ').trim();
  if (text) return text.length > 72 ? `${text.slice(0, 71)}…` : text;
  if (item.preparing) return 'Preparing activity';
  if (item.entry.kind === 'assistant' && item.entry.title)
    return item.entry.title;
  return fallback;
}

export function buildTranscriptLandmarks(
  items: readonly TranscriptModelItem[],
  groups: readonly TranscriptGroup[] = [],
): TranscriptLandmark[] {
  const result: TranscriptLandmark[] = [];
  const groupStarts = new Set(groups.map((group) => group.start));
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    if (groupStarts.has(index)) {
      const group = groups.find((candidate) => candidate.start === index);
      if (group)
        result.push({
          key: `group-${item.key}`,
          label: group.title,
          kind: 'activity',
          itemIndex: index,
        });
    }
    if (item.role === 'user')
      result.push({
        key: item.key,
        label: landmarkLabel(item, 'User turn'),
        kind: 'user',
        itemIndex: index,
      });
    else if (
      item.role === 'assistant' &&
      (item.text ||
        item.preparing ||
        (item.entry.kind === 'assistant' && item.entry.title))
    )
      result.push({
        key: item.key,
        label: landmarkLabel(item, 'Assistant activity'),
        kind: 'assistant',
        itemIndex: index,
      });
  }
  return result;
}

export function TranscriptOutline({
  landmarks,
  open = false,
  onOpenChange,
  onJump,
}: {
  landmarks: readonly TranscriptLandmark[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onJump: (landmark: TranscriptLandmark) => void;
}) {
  const [activeKey, setActiveKey] = useState(landmarks[0]?.key);
  useEffect(() => {
    setActiveKey((current) =>
      landmarks.some((landmark) => landmark.key === current)
        ? current
        : landmarks[0]?.key,
    );
    const updateActive = () => {
      const visible = landmarks
        .map((landmark) => {
          const element = Array.from(
            document.querySelectorAll<HTMLElement>('[data-transcript-key]'),
          ).find(
            (candidate) => candidate.dataset.transcriptKey === landmark.key,
          );
          return {
            landmark,
            top:
              element?.getBoundingClientRect().top ?? Number.NEGATIVE_INFINITY,
          };
        })
        .filter(({ top }) => top <= 120)
        .at(-1);
      if (visible) setActiveKey(visible.landmark.key);
    };
    window.addEventListener('scroll', updateActive, { passive: true });
    updateActive();
    return () => window.removeEventListener('scroll', updateActive);
  }, [landmarks]);
  const list = (
    <div className="transcript-outline-list">
      {landmarks.length ? (
        landmarks.map((landmark) => (
          <button
            type="button"
            className={`transcript-outline-item outline-${landmark.kind}`}
            key={landmark.key}
            onClick={() => {
              onJump(landmark);
              onOpenChange?.(false);
            }}
            title={landmark.label}
          >
            <i aria-hidden="true" />
            <span>{landmark.label}</span>
          </button>
        ))
      ) : (
        <p className="muted">No transcript landmarks yet.</p>
      )}
    </div>
  );
  return (
    <>
      <aside className="transcript-minimap" aria-label="Transcript outline">
        <span className="transcript-minimap-label">Outline</span>
        {landmarks.map((landmark) => (
          <button
            type="button"
            className={`transcript-minimap-marker outline-${landmark.kind}${activeKey === landmark.key ? ' active' : ''}`}
            key={landmark.key}
            aria-label={landmark.label}
            title={landmark.label}
            onClick={() => onJump(landmark)}
          >
            <i aria-hidden="true" />
          </button>
        ))}
      </aside>
      {open && (
        <div className="outline-sheet-layer">
          <button
            type="button"
            className="outline-sheet-backdrop"
            aria-label="Close transcript outline"
            onClick={() => onOpenChange?.(false)}
          />
          <section
            className="outline-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="transcript-outline-title"
          >
            <header>
              <div>
                <p className="eyebrow">This session</p>
                <h2 id="transcript-outline-title">Transcript outline</h2>
              </div>
              <button
                type="button"
                className="session-icon-button"
                aria-label="Close transcript outline"
                onClick={() => onOpenChange?.(false)}
              >
                ×
              </button>
            </header>
            {list}
          </section>
        </div>
      )}
    </>
  );
}

export function Transcript({
  entries,
  projection,
  runtime,
  outlineOpen,
  onOutlineOpenChange,
}: {
  /** Legacy raw-entry input retained for embedders. */
  entries?: unknown[];
  /** Preferred canonical domain projection input. */
  projection?: TranscriptProjection;
  runtime?: RuntimeSnapshot;
  outlineOpen?: boolean;
  onOutlineOpenChange?: (open: boolean) => void;
}) {
  const input = projection ?? entries ?? [];
  const items = useMemo(() => toTranscriptEntries(input), [input]);
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
  const landmarks = useMemo(
    () => buildTranscriptLandmarks(items, groups),
    [groups, items],
  );
  const jumpToLandmark = (landmark: TranscriptLandmark) => {
    const target = Array.from(
      document.querySelectorAll<HTMLElement>('[data-transcript-key]'),
    ).find((element) => element.dataset.transcriptKey === landmark.key);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
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
        outlineOpen={outlineOpen}
        onOutlineOpenChange={onOutlineOpenChange}
      />
    );
  return (
    <div className="transcript">
      <h2>Conversation &amp; activity</h2>
      <TranscriptOutline
        landmarks={landmarks}
        open={outlineOpen}
        onOpenChange={onOutlineOpenChange}
        onJump={jumpToLandmark}
      />
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
              data-transcript-key={`group-${groupKey}`}
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
        return (
          <div data-transcript-key={item.key} key={item.key}>
            <TranscriptEntry item={item} />
          </div>
        );
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

type ActivityStepTool = TranscriptGroup['tools'][number];

export function activityStepParts(tool: ActivityStepTool): {
  label: string;
  tool: string;
  argument?: string;
} {
  const name = toolBaseName(tool.name);
  const label = toolActionSummary(tool);
  const remainder = label.slice(name.length).trim();
  const argument = remainder.replace(/^:\s*/u, '');
  return {
    label,
    tool: name,
    ...(argument ? { argument } : {}),
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

function CollapsedActivitySummary({ group }: { group: TranscriptGroup }) {
  const summary = activityGroupSummary(group);
  const recentActions = group.tools
    .slice(-summary.recentTools.length)
    .map(activityStepParts);
  const stepKeyCounts = new Map<string, number>();
  return (
    <div className="activity-summary">
      {summary.earlierToolCount > 0 && (
        <span className="activity-earlier">
          ⋮ {summary.earlierToolCount} earlier step
          {summary.earlierToolCount === 1 ? '' : 's'}
        </span>
      )}
      {recentActions.length > 0 && (
        <ol className="activity-steps">
          {recentActions.map((action) => {
            const occurrence = (stepKeyCounts.get(action.label) ?? 0) + 1;
            stepKeyCounts.set(action.label, occurrence);
            return (
              <li key={`${action.label}-${occurrence}`} title={action.label}>
                <span className="activity-step-dot" aria-hidden="true">
                  ⏺
                </span>
                <span className="activity-tool-name">{action.tool}</span>
                {action.argument && (
                  <span className="activity-tool-argument">
                    {action.argument}
                  </span>
                )}
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
  if (group.status === 'failed')
    return {
      className: 'activity-failed',
      icon: '!',
      label: `failed · ${detail}`,
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
    className: 'activity-complete',
    icon: '✓',
    label: detail,
    status: group.status,
  };
}

function VirtualizedTranscript({
  items,
  groups,
  open,
  setOpen,
  runtime,
  outlineOpen,
  onOutlineOpenChange,
}: {
  items: readonly TranscriptModelItem[];
  groups: readonly TranscriptGroup[];
  open: ReadonlySet<string>;
  setOpen: Dispatch<SetStateAction<Set<string>>>;
  runtime?: RuntimeSnapshot;
  outlineOpen?: boolean;
  onOutlineOpenChange?: (open: boolean) => void;
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
  const landmarks = useMemo(
    () => buildTranscriptLandmarks(items, groups),
    [groups, items],
  );
  const rowIndexByKey = useMemo(() => {
    const result = new Map<string, number>();
    rows.forEach((row, index) => {
      result.set(row.key, index);
      if (row.kind === 'group') {
        result.set(row.key.replace(/^group-/, ''), index);
        for (
          let itemIndex = row.group.start;
          itemIndex <= row.group.end;
          itemIndex += 1
        ) {
          const item = items[itemIndex];
          if (item) result.set(item.key, index);
        }
      }
    });
    return result;
  }, [items, rows]);
  const jumpToLandmark = (landmark: TranscriptLandmark) => {
    const rowIndex = rowIndexByKey.get(landmark.key);
    if (rowIndex !== undefined)
      virtualizer.scrollToIndex(rowIndex, { align: 'start' });
  };
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
      <div
        className={`activity-group ${presentation.className}`}
        data-transcript-key={`group-${groupKey}`}
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
      <TranscriptOutline
        landmarks={landmarks}
        open={outlineOpen}
        onOpenChange={onOutlineOpenChange}
        onJump={jumpToLandmark}
      />
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
                <div data-transcript-key={items[row.index]?.key}>
                  <TranscriptEntry item={items[row.index]} />
                </div>
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

function toolInspectorRecord(
  tool: TranscriptRenderToolItem,
): Record<string, unknown> {
  return {
    toolCallId: tool.toolCallId,
    name: tool.name,
    ...(tool.arguments === undefined ? {} : { arguments: tool.arguments }),
    ...(tool.result === undefined ? {} : { result: tool.result }),
    ...(tool.isError === undefined ? {} : { isError: tool.isError }),
    status: tool.status,
    ...(tool.data === undefined ? {} : { data: tool.data }),
  };
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
  if (item.tool) {
    const tool = item.tool;
    const record = toolInspectorRecord(tool);
    return (
      <details className="transcript-entry tool-detail">
        <summary>
          <span className="tool-chip">{tool.name}</span>
          <span>
            {toolActionSummary({ name: tool.name, args: tool.arguments })}
          </span>
        </summary>
        <ToolInspector tool={record} />
      </details>
    );
  }
  const raw = item.raw;
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
