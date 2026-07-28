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

export function formatElapsed(startedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function stateStyle(status: DelegateStatusSnapshot): {
  icon: string;
  detail?: string;
  color: ThemeColor;
} {
  switch (status.state) {
    case 'queued':
      return { icon: '○', detail: 'queued', color: 'muted' };
    case 'running':
      return { icon: '●', color: 'warning' };
    case 'success':
      return { icon: '✓', detail: 'finalizing', color: 'success' };
    case 'error':
      return { icon: '×', detail: 'failed', color: 'error' };
    case 'timed-out':
      return { icon: '◷', detail: 'timed out', color: 'warning' };
    case 'aborted':
      return { icon: '■', detail: 'aborted', color: 'muted' };
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
  const elapsed = theme.fg('dim', formatElapsed(status.createdAt, now));
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
  const activity = status.activity;
  if (!activity)
    return status.state === 'queued' ? 'waiting for a slot' : 'starting';
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

/** Rank for display: what is happening now, then what is about to. */
const STATE_RANK: Record<DelegateStatusSnapshot['state'], number> = {
  running: 0,
  success: 1,
  error: 1,
  'timed-out': 1,
  aborted: 1,
  queued: 2,
};

/** Keep active work first while retaining every tracked subagent. */
function forDisplay(
  statuses: readonly DelegateStatusSnapshot[],
): DelegateStatusSnapshot[] {
  return [...statuses].sort(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state],
  );
}

function compactSummary(statuses: readonly DelegateStatusSnapshot[]): string {
  const count = (state: DelegateStatusSnapshot['state']) =>
    statuses.filter((status) => status.state === state).length;
  const running = count('running');
  const queued = count('queued');
  const parts = [
    running > 0 ? `${running} running` : '',
    queued > 0 ? `${queued} queued` : '',
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

  const lines = forDisplay(statuses).flatMap((status) => {
    const main = mainLine(status, blockWidth, theme, now);
    return status.state === 'queued' || status.state === 'running'
      ? [main, actionLine(status, blockWidth, theme, markdownTheme)]
      : [main];
  });
  return placeBlock(lines, width);
}
