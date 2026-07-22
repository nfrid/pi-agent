import {
  getMarkdownTheme,
  keyHint,
  type ThemeColor,
} from '@earendil-works/pi-coding-agent';
import {
  type Component,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import {
  type DelegateDetails,
  type DelegatedRun,
  type DelegateRunState,
  getRunState,
} from './types';

export const TASK_PREVIEW_CHARS = 220;
export const ACTIVITY_PREVIEW_CHARS = 280;
export const RESULT_PREVIEW_CHARS = 420;
export const FINAL_PREVIEW_CHARS = 700;
export const FINAL_PREVIEW_LINES = 10;

export type ThemeLike = {
  fg: (color: ThemeColor, text: string) => string;
  bold: (text: string) => string;
};

export type ToolResultLike = {
  content?: unknown;
  details?: DelegateDetails;
};

export type DelegateCallTask = {
  task?: unknown;
  route?: unknown;
  cwd?: unknown;
  context?: unknown;
  allowWrites?: unknown;
  continuation?: unknown;
};

export type DelegateCallArgs = DelegateCallTask & {
  tasks?: DelegateCallTask[];
};

export type RenderContextLike = {
  cwd?: string;
  expanded?: boolean;
  executionStarted?: boolean;
};

export function truncate(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

class WrappedTask implements Component {
  constructor(
    private readonly prefix: string,
    private readonly value: string,
    private readonly color: (text: string) => string,
    private readonly expanded: boolean,
  ) {}

  render(width: number): string[] {
    const prefixWidth = visibleWidth(this.prefix);
    if (width <= prefixWidth)
      return [truncateToWidth(this.prefix, Math.max(1, width), '…')];

    const available = width - prefixWidth;
    const text = this.expanded
      ? this.value
      : this.value.replace(/\s+/g, ' ').trim();
    const wrapped = wrapTextWithAnsi(this.color(text), available);
    const visible = this.expanded ? wrapped : wrapped.slice(0, 3);
    if (!this.expanded && wrapped.length > visible.length) {
      const last = visible.length - 1;
      visible[last] = `${truncateToWidth(
        visible[last] ?? '',
        Math.max(1, available - 1),
        '',
      )}${this.color('…')}`;
    }
    const indent = ' '.repeat(prefixWidth);
    return visible.map((line, index) =>
      truncateToWidth(
        `${index === 0 ? this.prefix : indent}${line}`,
        width,
        '',
      ),
    );
  }

  invalidate(): void {}
}

/** Render a task in at most three terminal lines, or without truncation when expanded. */
export function taskBlock(
  label: string,
  value: unknown,
  expanded: boolean,
  fg: (color: ThemeColor, text: string) => string,
): Component {
  const text = String(value || '...').trim() || '...';
  const prefix = fg('accent', `${label.padEnd(7)} `);
  return new WrappedTask(prefix, text, (part) => fg('text', part), expanded);
}

/** Render an indexed task in at most three terminal lines. */
export function indexedTaskBlock(
  prefix: string,
  value: unknown,
  fg: (color: ThemeColor, text: string) => string,
): Component {
  const text = String(value || '...').trim() || '...';
  return new WrappedTask(prefix, text, (part) => fg('text', part), false);
}

export function hasResultHeading(text: string): boolean {
  return /^(?:#{1,6}\s+|\*\*)result\b/i.test(text.trim());
}

export function markdownPreview(text: string): string {
  const lines = text.trim().split('\n');
  let preview = lines.slice(0, FINAL_PREVIEW_LINES).join('\n');
  let truncated = lines.length > FINAL_PREVIEW_LINES;
  if (preview.length > FINAL_PREVIEW_CHARS) {
    preview = preview.slice(0, FINAL_PREVIEW_CHARS).trimEnd();
    truncated = true;
  }
  if (!truncated) return preview;
  if ((preview.match(/```/g)?.length ?? 0) % 2 === 1) preview += '\n```';
  return `${preview}\n\n…`;
}

function count(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function usage(run: DelegatedRun): string {
  const parts: string[] = [];
  if (run.usage.turns)
    parts.push(`${run.usage.turns} turn${run.usage.turns === 1 ? '' : 's'}`);
  if (run.usage.input) parts.push(`↑${count(run.usage.input)}`);
  if (run.usage.output) parts.push(`↓${count(run.usage.output)}`);
  if (run.usage.cacheRead) parts.push(`R${count(run.usage.cacheRead)}`);
  if (run.usage.cacheWrite) parts.push(`W${count(run.usage.cacheWrite)}`);
  if (run.usage.contextTokens)
    parts.push(`ctx:${count(run.usage.contextTokens)}`);
  if (run.usage.cost) parts.push(`$${run.usage.cost.toFixed(4)}`);
  return parts.join(' ');
}

export function compactPath(value: unknown): string {
  if (typeof value !== 'string' || !value) return '.';
  const home = process.env.HOME;
  return home && (value === home || value.startsWith(`${home}/`))
    ? `~${value.slice(home.length)}`
    : value;
}

export function capitalize(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function contextLabel(values: {
  context?: unknown;
  continuation?: unknown;
}): string {
  if (values.continuation || values.context === 'continuation')
    return 'Continued context';
  return values.context === 'branch' ? 'Parent context' : 'Fresh context';
}

export function modeDescription(
  values: {
    context?: unknown;
    continuation?: unknown;
    allowWrites?: unknown;
    cwd?: unknown;
    route?: unknown;
    requestedMode?: boolean;
  },
  fg: (color: ThemeColor, text: string) => string,
): string {
  const separator = fg('dim', ' · ');
  const parts = [
    fg('dim', contextLabel(values)),
    fg(
      values.allowWrites === true ? 'warning' : 'dim',
      values.allowWrites === true
        ? values.requestedMode
          ? 'Requests edits'
          : 'Can edit'
        : 'Read-only',
    ),
    fg('dim', compactPath(values.cwd)),
  ];
  if (typeof values.route === 'string' && values.route)
    parts.push(fg('accent', values.route));
  return parts.join(separator);
}

export function isolationLines(run: DelegatedRun): string[] {
  if (!run.isolation) {
    return run.readOnlyBoundary ? [`Boundary: ${run.readOnlyBoundary}`] : [];
  }
  const lines = [
    `Isolation: ${run.isolation.id}`,
    `State: ${run.isolation.status} · ${run.isolation.backend}`,
    `Worktree: ${compactPath(run.isolation.worktreePath)}`,
    `Dependencies: ${run.isolation.dependencyMode}`,
  ];
  if (run.isolation.patch)
    lines.push(
      `Patch: ${run.isolation.patch.changedPaths.length} path(s) · ${run.isolation.patch.size} bytes · sha256 ${run.isolation.patch.sha256}`,
      ...run.isolation.patch.changedPaths.map((name) => `- ${name}`),
    );
  if (run.isolation.validation)
    lines.push(
      `Validation: ${run.isolation.validation.status}${run.isolation.validation.script ? ` (${run.isolation.validation.script})` : ''}`,
    );
  lines.push(
    `Actions: /delegate-patch ${run.isolation.id} show|diff|validate <script>|validate-command <argv...>|apply|discard`,
  );
  return lines;
}

export function formatDuration(run: DelegatedRun): string {
  const start = run.startedAt ?? run.queuedAt;
  if (!start || !Number.isFinite(start)) return '';
  const end = run.finishedAt ?? Date.now();
  const milliseconds = Math.max(0, end - start);
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes < 60
    ? `${minutes}m ${remainder}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function stateLabel(run: DelegatedRun): string {
  const state = getRunState(run);
  return state === 'success'
    ? 'done'
    : state === 'timed-out'
      ? 'timed out'
      : state;
}

export function runtimeLabel(run: DelegatedRun): string {
  const duration = formatDuration(run);
  return duration ? `${stateLabel(run)} • ${duration}` : stateLabel(run);
}

export function icon(
  run: DelegatedRun,
  fg: (color: ThemeColor, text: string) => string,
): string {
  const state = getRunState(run);
  if (state === 'queued') return fg('muted', '○');
  if (state === 'running') return fg('muted', '…');
  if (state === 'error') return fg('error', '×');
  if (state === 'aborted') return fg('warning', '−');
  if (state === 'timed-out') return fg('warning', '◷');
  return fg('success', '✓');
}

export function stateColor(state: DelegateRunState): ThemeColor {
  if (state === 'success') return 'success';
  if (state === 'error') return 'error';
  if (state === 'aborted' || state === 'timed-out') return 'warning';
  return 'muted';
}

export function activityLabel(
  activity: DelegatedRun['activities'][number],
  fg: (color: ThemeColor, text: string) => string,
): string {
  if (activity.status === 'error') return fg('error', activity.label);
  if (activity.type === 'thinking') return fg('thinkingText', activity.label);
  const separator = activity.label.indexOf(' ');
  if (separator < 0) return fg('success', activity.label);
  return `${fg('success', activity.label.slice(0, separator))}${fg('dim', activity.label.slice(separator))}`;
}

export function activityLines(
  run: DelegatedRun,
  fg: (color: ThemeColor, text: string) => string,
): string {
  const lines: string[] = [];
  for (const activity of run.activities) {
    const marker =
      activity.status === 'running'
        ? fg('muted', '…')
        : activity.status === 'error'
          ? fg('error', '×')
          : fg('dim', '✓');
    lines.push(`${marker} ${activityLabel(activity, fg)}`);
    if (activity.type === 'tool' && activity.latestText)
      lines.push(
        fg('dim', truncate(activity.latestText, ACTIVITY_PREVIEW_CHARS)),
      );
  }
  return lines.join('\n');
}

export function fieldLine(
  label: string,
  value: string,
  fg: (color: ThemeColor, text: string) => string,
  valueColor: ThemeColor | null = 'toolOutput',
): string {
  return `${fg(label.endsWith('Task') ? 'accent' : 'muted', `${label.padEnd(7)} `)}${valueColor ? fg(valueColor, value) : value}`;
}

export function sectionTitle(title: string, theme: ThemeLike): Text {
  return new Text(theme.fg('accent', theme.bold(title)), 0, 0);
}

export function controls(runs: DelegatedRun[]): string {
  const hints = [keyHint('app.tools.expand', 'details')];
  if (runs.some((run) => ['queued', 'running'].includes(getRunState(run))))
    hints.push(keyHint('app.interrupt', 'cancel'));
  return hints.join(' · ');
}

export function currentActivityLines(
  run: DelegatedRun,
  fg: (color: ThemeColor, text: string) => string,
): string[] {
  const state = getRunState(run);
  if (state === 'queued')
    return [fieldLine('Status', 'Waiting for a slot', fg, 'dim')];
  if (state !== 'running') return [];
  const latest = run.activities.at(-1);
  const lines = latest
    ? [
        `${fg('muted', `${(latest.status === 'running' ? 'Now' : 'Last').padEnd(7)} `)}${activityLabel(
          { ...latest, label: truncate(latest.label, TASK_PREVIEW_CHARS) },
          fg,
        )}`,
      ]
    : [fieldLine('Now', 'Starting subagent', fg, 'dim')];
  const completed = run.activities.filter(
    (activity) => activity.status === 'completed',
  ).length;
  if (completed > 0)
    lines.push(
      fg(
        'dim',
        `${''.padEnd(8)}${completed} step${completed === 1 ? '' : 's'} completed`,
      ),
    );
  return lines;
}

export function getDetails(
  toolResult: ToolResultLike,
): DelegateDetails | undefined {
  return toolResult.details;
}

export function fallbackText(toolResult: ToolResultLike): string {
  const content = toolResult.content;
  if (!Array.isArray(content)) return '(no output)';
  const text = content.find((part): part is { type: 'text'; text: string } => {
    if (!part || typeof part !== 'object') return false;
    const candidate = part as { type?: unknown; text?: unknown };
    return candidate.type === 'text' && typeof candidate.text === 'string';
  });
  return text?.text || '(no output)';
}

export { getMarkdownTheme };
