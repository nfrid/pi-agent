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
export const DELEGATE_WIDGET_MAX_AGENTS = 4;
const MODE_ROUTE_MAX_WIDTH = 16;

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
  const tail =
    candidates.find((candidate) => visibleWidth(candidate) <= tailBudget) ??
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
  if (activity.type === 'thinking')
    return activity.latestText ? compact(activity.latestText) : '';
  return compact(
    [activity.label, activity.latestText].filter(Boolean).join(' · '),
  );
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
    return rendered.find((line) => visibleWidth(line) > 0) ?? '';
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
        `${statuses.length} subagent${statuses.length === 1 ? '' : 's'} active`,
      ) +
      theme.fg('dim', ' · ') +
      theme.fg('accent', '/delegates');
    return placeBlock([line], width);
  }

  const visible = statuses.slice(0, DELEGATE_WIDGET_MAX_AGENTS);
  const lines = visible.flatMap((status) => [
    mainLine(status, blockWidth, theme, now),
    actionLine(status, blockWidth, theme, markdownTheme),
  ]);
  if (statuses.length > visible.length)
    lines.push(
      theme.fg('dim', `+${statuses.length - visible.length} more subagents`),
    );
  return placeBlock(lines, width);
}
