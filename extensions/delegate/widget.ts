import {
  getMarkdownTheme,
  type ThemeColor,
} from '@earendil-works/pi-coding-agent';
import {
  Markdown,
  type MarkdownTheme,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';
import type { DelegateStatusSnapshot } from './status';

export const DELEGATE_WIDGET_MAX_WIDTH = 68;
/** Successful rows are history; active and failed rows are always retained. */
export const DELEGATE_WIDGET_MAX_SUCCESS_ROWS = 8;
/** Narrower than this a subagent row is name and elapsed time and nothing else. */
export const DELEGATE_WIDGET_MIN_WIDTH = 30;
const MODE_ROUTE_MAX_WIDTH = 16;
/** Columns the name keeps before the row trades indicators away for it. */
const MIN_NAME_WIDTH = 14;

export interface DelegateWidgetTheme {
  fg(color: ThemeColor, text: string): string;
}

function compact(text: string): string {
  return text.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatElapsed(startedAt: number, now = Date.now()): string {
  return formatDuration(now - startedAt);
}

function effectiveState(status: DelegateStatusSnapshot): string {
  return status.workflow?.state ?? status.state;
}

function elapsedTime(status: DelegateStatusSnapshot, now: number): string {
  const effectiveNow = status.pausedAt ?? now;
  if (status.runs)
    return formatDuration(
      status.runs.reduce((total, run) => {
        if (run.startedAt === undefined) return total;
        const finished =
          run.state === 'queued' || run.state === 'running'
            ? effectiveNow
            : (run.finishedAt ?? run.startedAt);
        return total + Math.max(0, finished - run.startedAt);
      }, 0),
    );
  if (status.startedAt === undefined)
    return formatElapsed(effectiveNow, effectiveNow);
  const finished =
    effectiveState(status) === 'scheduled' ||
    effectiveState(status) === 'queued' ||
    effectiveState(status) === 'running'
      ? effectiveNow
      : (status.finishedAt ?? status.startedAt);
  return formatElapsed(status.startedAt, finished);
}

function stateStyle(status: DelegateStatusSnapshot): {
  icon: string;
  detail?: string;
  color: ThemeColor;
} {
  if (status.pauseState === 'paused')
    return { icon: '||', detail: 'paused', color: 'warning' };
  if (status.pauseState === 'pausing')
    return { icon: '..', detail: 'pausing', color: 'warning' };
  switch (effectiveState(status)) {
    case 'scheduled':
      return {
        icon: '○',
        detail: status.workflow?.waitingFor?.length
          ? `waiting for ${status.workflow.waitingFor.join(', ')}`
          : 'scheduled',
        color: 'muted',
      };
    case 'queued':
      return { icon: '○', detail: 'queued', color: 'muted' };
    case 'running':
      return { icon: '●', color: 'warning' };
    case 'success':
      return { icon: '✓', detail: 'done', color: 'success' };
    case 'error':
      return { icon: '×', detail: 'failed', color: 'error' };
    case 'timed-out':
      return { icon: '◷', detail: 'timed out', color: 'warning' };
    case 'aborted':
      return { icon: '■', detail: 'aborted', color: 'muted' };
    case 'cancelled':
      return { icon: '−', detail: 'cancelled', color: 'muted' };
    case 'blocked':
      return {
        icon: '!',
        detail: status.workflow?.reason
          ? `blocked: ${compact(status.workflow.reason)}`
          : 'blocked',
        color: 'error',
      };
    default:
      return { icon: '○', detail: effectiveState(status), color: 'muted' };
  }
}

function accessIndicator(
  status: DelegateStatusSnapshot,
  theme: DelegateWidgetTheme,
): string {
  return theme.fg(
    status.allowWrites ? 'warning' : 'success',
    status.allowWrites ? 'rw' : 'ro',
  );
}

function contextIndicator(
  status: DelegateStatusSnapshot,
  theme: DelegateWidgetTheme,
): string {
  if ((status.runCount ?? 1) > 1)
    return theme.fg('accent', `run ${status.runCount}`);
  if (status.context === 'branch') return theme.fg('warning', 'branch');
  if (status.context === 'continuation') return theme.fg('accent', 'cont');
  if (status.context === 'fresh') return theme.fg('muted', 'fresh');
  return '';
}

function modeIndicator(
  status: DelegateStatusSnapshot,
  theme: DelegateWidgetTheme,
): string {
  const parts = [
    status.workflow?.identity
      ? theme.fg('accent', compact(status.workflow.identity))
      : '',
    status.route
      ? theme.fg(
          'toolTitle',
          truncateToWidth(compact(status.route), MODE_ROUTE_MAX_WIDTH, '…'),
        )
      : '',
    contextIndicator(status, theme),
    accessIndicator(status, theme),
  ].filter(Boolean);
  return parts.join(theme.fg('dim', '/'));
}

function mainLine(
  status: DelegateStatusSnapshot,
  width: number,
  theme: DelegateWidgetTheme,
  now: number,
): string {
  const state = stateStyle(status);
  const prefix = `${theme.fg(state.color, state.icon)} `;
  const elapsed = theme.fg('dim', elapsedTime(status, now));
  const access = accessIndicator(status, theme);
  const detail = state.detail ? theme.fg('dim', state.detail) : '';
  const mode = modeIndicator(status, theme);
  const tailBudget = Math.max(1, width - visibleWidth(prefix) - 2);
  const candidates = [
    [detail, mode, elapsed].filter(Boolean).join('  '),
    [detail, access, elapsed].filter(Boolean).join('  '),
    [access, elapsed].join('  '),
    elapsed,
  ];
  // A narrow row that spends everything on indicators leaves the name as an
  // ellipsis, which is the one thing telling the subagents apart.
  const nameBudget = width - visibleWidth(prefix) - MIN_NAME_WIDTH - 1;
  const budget = Math.min(tailBudget, Math.max(1, nameBudget));
  const tail =
    candidates.find((candidate) => visibleWidth(candidate) <= budget) ??
    elapsed;
  const nameWidth = Math.max(
    1,
    width - visibleWidth(prefix) - visibleWidth(tail) - 1,
  );
  const name = theme.fg(
    'text',
    truncateToWidth(compact(status.name) || 'Subagent', nameWidth, '…'),
  );
  const gap = ' '.repeat(
    Math.max(
      1,
      width - visibleWidth(prefix) - visibleWidth(name) - visibleWidth(tail),
    ),
  );
  return truncateToWidth(`${prefix}${name}${gap}${tail}`, width, '…');
}

function actionMarker(status: DelegateStatusSnapshot): {
  text: string;
  color: ThemeColor;
} {
  if (status.pauseState === 'paused') return { text: '||', color: 'warning' };
  if (status.pauseState === 'pausing') return { text: '..', color: 'warning' };
  const activity = status.activity;
  if (!activity)
    return status.state === 'queued'
      ? { text: '○', color: 'muted' }
      : { text: '…', color: 'muted' };
  if (activity.status === 'error') return { text: '×', color: 'error' };
  if (activity.status === 'completed') return { text: '✓', color: 'dim' };
  return { text: '…', color: 'warning' };
}

function actionContent(status: DelegateStatusSnapshot): string {
  if (status.pauseState === 'paused') return 'Paused at a safe boundary';
  if (status.pauseState === 'pausing') return 'Pausing at a safe boundary';
  const activity = status.activity;
  if (status.workflow?.waitingFor?.length)
    return `waiting for ${status.workflow.waitingFor.join(', ')}`;
  if (!activity)
    return effectiveState(status) === 'queued' ||
      effectiveState(status) === 'scheduled'
      ? 'waiting for a slot'
      : 'starting';
  // A thinking block with no text yet is the very first activity of a run;
  // later ones fall back to the previous activity before reaching here.
  if (activity.type === 'thinking')
    return activity.latestText ? compact(activity.latestText) : 'thinking';
  return compact(
    [activity.label, activity.latestText].filter(Boolean).join(' · '),
  );
}

/** Visible width ignoring the padding a rendered markdown line carries. */
function contentWidth(line: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR escapes
  return visibleWidth(line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd());
}

function renderThinking(
  markdown: string,
  width: number,
  color: (text: string) => string,
  markdownTheme?: MarkdownTheme,
): string {
  try {
    const rendered = new Markdown(
      markdown,
      0,
      0,
      markdownTheme ?? getMarkdownTheme(),
      { color },
    ).render(Math.max(1, width));
    // The last wrapped line holds the newest words, so the preview advances
    // with the stream instead of freezing on how the paragraph opened. A line
    // that has only just started wrapping would leave the row almost empty,
    // so until it has filled up the previous, complete line is shown instead.
    const lines = rendered.filter((line) => contentWidth(line) > 0);
    const last = lines.at(-1) ?? '';
    const previous = lines.at(-2);
    return previous && contentWidth(last) * 2 < width ? previous : last;
  } catch {
    // A malformed partial markdown fragment must never break the parent TUI.
    return truncateToWidth(markdown, Math.max(1, width), '…');
  }
}

function actionLine(
  status: DelegateStatusSnapshot,
  width: number,
  theme: DelegateWidgetTheme,
  markdownTheme?: MarkdownTheme,
): string {
  const marker = actionMarker(status);
  const prefix = `${theme.fg('dim', '└')} ${theme.fg(marker.color, marker.text)} `;
  const available = Math.max(1, width - visibleWidth(prefix));
  const content = actionContent(status);
  const activity = status.activity;
  const rendered =
    activity?.type === 'thinking'
      ? renderThinking(
          content,
          available,
          (text) =>
            theme.fg(
              activity.status === 'error'
                ? 'error'
                : activity.status === 'completed'
                  ? 'dim'
                  : 'thinkingText',
              text,
            ),
          markdownTheme,
        )
      : activity?.type === 'tool'
        ? [
            theme.fg(
              activity.status === 'error'
                ? 'error'
                : activity.status === 'completed'
                  ? 'muted'
                  : 'toolTitle',
              compact(activity.label),
            ),
            activity.latestText
              ? theme.fg(
                  activity.status === 'error'
                    ? 'error'
                    : activity.status === 'completed'
                      ? 'dim'
                      : 'toolOutput',
                  compact(activity.latestText),
                )
              : '',
          ]
            .filter(Boolean)
            .join(theme.fg('dim', ' · '))
        : theme.fg('muted', content);
  return truncateToWidth(`${prefix}${rendered}`, width, '…');
}

function placeBlock(lines: string[], width: number): string[] {
  const blockWidth = Math.max(1, Math.min(width, DELEGATE_WIDGET_MAX_WIDTH));
  const left = ' '.repeat(Math.max(0, width - blockWidth));
  return lines.map(
    (line) => `${left}${truncateToWidth(line, blockWidth, '…')}`,
  );
}

/** Rank for display: active work, failures, then successful history. */
const STATE_RANK: Record<string, number> = {
  running: 0,
  scheduled: 1,
  queued: 1,
  error: 2,
  'timed-out': 2,
  aborted: 2,
  cancelled: 2,
  blocked: 2,
  success: 3,
};

function isActive(status: DelegateStatusSnapshot): boolean {
  const state = effectiveState(status);
  return state === 'scheduled' || state === 'queued' || state === 'running';
}

function isFailure(status: DelegateStatusSnapshot): boolean {
  const state = effectiveState(status);
  return (
    state === 'error' ||
    state === 'timed-out' ||
    state === 'aborted' ||
    state === 'cancelled' ||
    state === 'blocked'
  );
}

interface DisplayRows {
  rows: DelegateStatusSnapshot[];
  hiddenSuccesses: number;
}

/**
 * Keep active/error work visible, while completed success history is bounded.
 * The store remains authoritative; this only limits the persistent rail.
 */
function forDisplay(statuses: readonly DelegateStatusSnapshot[]): DisplayRows {
  const ordered = [...statuses].sort(
    (a, b) => STATE_RANK[effectiveState(a)] - STATE_RANK[effectiveState(b)],
  );
  const active = ordered.filter(isActive);
  const terminal = statuses.filter((status) => !isActive(status));
  const successes = terminal
    .map((status, index) => ({ status, index }))
    .filter(({ status }) => effectiveState(status) === 'success');
  const newestSuccesses = [...successes]
    .sort(
      (a, b) =>
        (a.status.finishedAt ?? a.status.createdAt ?? a.index) -
        (b.status.finishedAt ?? b.status.createdAt ?? b.index),
    )
    .slice(-DELEGATE_WIDGET_MAX_SUCCESS_ROWS)
    .map(({ status }) => status);
  const visibleSuccesses = new Set(newestSuccesses);
  const visibleTerminal = terminal.filter(
    (status) => isFailure(status) || visibleSuccesses.has(status),
  );
  return {
    rows: [...active, ...visibleTerminal],
    hiddenSuccesses: Math.max(
      0,
      successes.length - DELEGATE_WIDGET_MAX_SUCCESS_ROWS,
    ),
  };
}

function compactSummary(statuses: readonly DelegateStatusSnapshot[]): string {
  const count = (state: string) =>
    statuses.filter((status) => effectiveState(status) === state).length;
  const running = count('running');
  const queued = count('queued');
  const failed = statuses.filter((status) => isFailure(status)).length;
  const completed = statuses.filter(
    (status) => effectiveState(status) === 'success',
  ).length;
  const parts = [
    running > 0 ? `${running} running` : '',
    queued > 0 ? `${queued} queued` : '',
    failed > 0 ? `${failed} failed` : '',
    running === 0 && queued === 0 && completed > 0
      ? `${completed} completed`
      : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'finishing';
}

export function renderDelegateWidget(
  statuses: readonly DelegateStatusSnapshot[],
  detailed: boolean,
  width: number,
  theme: DelegateWidgetTheme,
  now = Date.now(),
  markdownTheme?: MarkdownTheme,
): string[] {
  if (statuses.length === 0 || width <= 0) return [];
  const blockWidth = Math.max(1, Math.min(width, DELEGATE_WIDGET_MAX_WIDTH));
  if (!detailed) {
    const line =
      theme.fg('warning', '● ') +
      theme.fg(
        'text',
        `${statuses.length} subagent${statuses.length === 1 ? '' : 's'}`,
      ) +
      theme.fg('dim', ' · ') +
      theme.fg('muted', compactSummary(statuses)) +
      theme.fg('dim', ' · ') +
      theme.fg('accent', '/delegates');
    return placeBlock([line], width);
  }

  const display = forDisplay(statuses);
  const lines = display.rows.flatMap((status) => {
    const main = mainLine(status, blockWidth, theme, now);
    return isActive(status)
      ? [main, actionLine(status, blockWidth, theme, markdownTheme)]
      : [main];
  });
  if (display.hiddenSuccesses > 0)
    lines.push(
      theme.fg(
        'dim',
        `… ${display.hiddenSuccesses} completed delegate${display.hiddenSuccesses === 1 ? '' : 's'} hidden`,
      ),
    );
  return placeBlock(lines, width);
}
