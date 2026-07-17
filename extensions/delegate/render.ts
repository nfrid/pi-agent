import {
  getMarkdownTheme,
  keyHint,
  type ThemeColor,
} from '@earendil-works/pi-coding-agent';
import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui';
import {
  type DelegateDetails,
  type DelegatedRun,
  type DelegateRunState,
  getFinalAssistantText,
  getRunState,
} from './types';

const TASK_PREVIEW_CHARS = 220;
const ACTIVITY_PREVIEW_CHARS = 280;
const RESULT_PREVIEW_CHARS = 420;
const FINAL_PREVIEW_CHARS = 700;
const FINAL_PREVIEW_LINES = 10;

type ThemeLike = {
  fg: (color: ThemeColor, text: string) => string;
  bold: (text: string) => string;
};

type ToolResultLike = {
  content?: unknown;
  details?: DelegateDetails;
};

type DelegateCallTask = {
  task?: unknown;
  route?: unknown;
  cwd?: unknown;
  context?: unknown;
  allowWrites?: unknown;
  continuation?: unknown;
};

type DelegateCallArgs = DelegateCallTask & {
  tasks?: DelegateCallTask[];
};

type RenderContextLike = {
  cwd?: string;
  expanded?: boolean;
  executionStarted?: boolean;
};

function truncate(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function taskText(value: unknown, expanded: boolean): string {
  const text = String(value || '...').trim();
  return expanded ? text : truncate(text, TASK_PREVIEW_CHARS);
}

function hasResultHeading(text: string): boolean {
  return /^(?:#{1,6}\s+|\*\*)result\b/i.test(text.trim());
}

function markdownPreview(text: string): string {
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

function usage(run: DelegatedRun): string {
  const parts: string[] = [];
  if (run.usage.turns)
    parts.push(`${run.usage.turns} turn${run.usage.turns === 1 ? '' : 's'}`);
  if (run.usage.computeUnits) parts.push(`${run.usage.computeUnits}cu`);
  if (run.usage.input) parts.push(`↑${count(run.usage.input)}`);
  if (run.usage.output) parts.push(`↓${count(run.usage.output)}`);
  if (run.usage.cacheRead) parts.push(`R${count(run.usage.cacheRead)}`);
  if (run.usage.cacheWrite) parts.push(`W${count(run.usage.cacheWrite)}`);
  if (run.usage.contextTokens)
    parts.push(`ctx:${count(run.usage.contextTokens)}`);
  if (run.usage.cost) parts.push(`$${run.usage.cost.toFixed(4)}`);
  return parts.join(' ');
}

function compactPath(value: unknown): string {
  if (typeof value !== 'string' || !value) return '.';
  const home = process.env.HOME;
  return home && (value === home || value.startsWith(`${home}/`))
    ? `~${value.slice(home.length)}`
    : value;
}

function capitalize(value: string): string {
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

function modeDescription(
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

function isolationLines(run: DelegatedRun): string[] {
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

function formatDuration(run: DelegatedRun): string {
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

function stateLabel(run: DelegatedRun): string {
  const state = getRunState(run);
  const duration = formatDuration(run);
  const label =
    state === 'success' ? 'done' : state === 'timed-out' ? 'timed out' : state;
  return duration ? `${label} • ${duration}` : label;
}

function icon(
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

function stateColor(state: DelegateRunState): ThemeColor {
  if (state === 'success') return 'success';
  if (state === 'error') return 'error';
  if (state === 'aborted' || state === 'timed-out') return 'warning';
  return 'muted';
}

function activityLabel(
  activity: DelegatedRun['activities'][number],
  fg: (color: ThemeColor, text: string) => string,
): string {
  if (activity.status === 'error') return fg('error', activity.label);
  if (activity.type === 'thinking') return fg('thinkingText', activity.label);
  const separator = activity.label.indexOf(' ');
  if (separator < 0) return fg('success', activity.label);
  return `${fg('success', activity.label.slice(0, separator))}${fg('dim', activity.label.slice(separator))}`;
}

function activityLines(
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
    // A thinking activity's label is its concise trace title. Its full text can
    // contain the provider's cumulative title group, which repeats prior traces.
    if (activity.type === 'tool' && activity.latestText)
      lines.push(
        fg('dim', truncate(activity.latestText, ACTIVITY_PREVIEW_CHARS)),
      );
  }
  return lines.join('\n');
}

function fieldLine(
  label: string,
  value: string,
  fg: (color: ThemeColor, text: string) => string,
  valueColor: ThemeColor | null = 'toolOutput',
): string {
  return `${fg(label.endsWith('Task') ? 'accent' : 'muted', `${label.padEnd(7)} `)}${valueColor ? fg(valueColor, value) : value}`;
}

function sectionTitle(title: string, theme: ThemeLike): Text {
  return new Text(theme.fg('accent', theme.bold(title)), 0, 0);
}

function controls(runs: DelegatedRun[]): string {
  const hints = [keyHint('app.tools.expand', 'details')];
  if (runs.some((run) => ['queued', 'running'].includes(getRunState(run))))
    hints.push(keyHint('app.interrupt', 'cancel'));
  return hints.join(' · ');
}

function currentActivityLines(
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

function getDetails(toolResult: ToolResultLike): DelegateDetails | undefined {
  return toolResult.details;
}

function fallbackText(toolResult: ToolResultLike): string {
  const content = toolResult.content;
  if (!Array.isArray(content)) return '(no output)';
  const text = content.find((part): part is { type: 'text'; text: string } => {
    if (!part || typeof part !== 'object') return false;
    const candidate = part as { type?: unknown; text?: unknown };
    return candidate.type === 'text' && typeof candidate.text === 'string';
  });
  return text?.text || '(no output)';
}

export function renderDelegateCall(
  args: DelegateCallArgs,
  theme: ThemeLike,
  context?: RenderContextLike,
) {
  // Once execution starts, result details own the complete card. This avoids
  // showing the task twice while keeping it visible during argument streaming.
  if (context?.executionStarted) return new Container();

  const fg = theme.fg.bind(theme);
  const expanded = context?.expanded === true;
  if (Array.isArray(args.tasks) && args.tasks.length > 0) {
    const visibleTasks = expanded ? args.tasks : args.tasks.slice(0, 3);
    let text = `${fg('toolTitle', theme.bold('Delegate'))} ${fg('muted', `· ${args.tasks.length} subagents`)}`;
    for (const [index, task] of visibleTasks.entries()) {
      text += `\n${fieldLine(
        `${index + 1} Task`,
        taskText(task.task, expanded),
        fg,
        'text',
      )}`;
      text += `\n${fieldLine(
        'Mode',
        modeDescription(
          {
            context: task.context ?? args.context,
            continuation: task.continuation,
            allowWrites: task.allowWrites ?? args.allowWrites,
            cwd: task.cwd ?? args.cwd ?? context?.cwd,
            route: task.route ?? args.route,
            requestedMode: true,
          },
          fg,
        ),
        fg,
        null,
      )}`;
    }
    if (!expanded && args.tasks.length > visibleTasks.length)
      text += `\n${fg('muted', `… ${args.tasks.length - visibleTasks.length} more subagents`)}`;
    return new Text(text, 0, 0);
  }

  const text = [
    fg('toolTitle', theme.bold('Delegate')),
    fieldLine('Task', taskText(args.task, expanded), fg, 'text'),
    fieldLine(
      'Mode',
      modeDescription(
        {
          context: args.context,
          continuation: args.continuation,
          allowWrites: args.allowWrites,
          cwd: args.cwd ?? context?.cwd,
          route: args.route,
          requestedMode: true,
        },
        fg,
      ),
      fg,
      null,
    ),
  ].join('\n');
  return new Text(text, 0, 0);
}

function addExpandedRun(
  container: Container,
  run: DelegatedRun,
  theme: ThemeLike,
  label?: string,
): void {
  const fg = theme.fg.bind(theme);
  const state = getRunState(run);
  const mdTheme = getMarkdownTheme();
  if (label)
    container.addChild(
      new Text(
        `${icon(run, fg)} ${fg('toolTitle', theme.bold(label))} ${fg(stateColor(state), `· ${stateLabel(run)}`)}`,
        0,
        0,
      ),
    );

  container.addChild(new Spacer(1));
  container.addChild(sectionTitle('Task', theme));
  container.addChild(new Text(run.task.trim() || '(no task)', 0, 0));

  container.addChild(new Spacer(1));
  container.addChild(sectionTitle('Mode', theme));
  container.addChild(
    new Text(
      modeDescription(
        {
          context: run.context,
          continuation:
            run.context === 'continuation' ? run.continuation : undefined,
          allowWrites: run.allowWrites,
          cwd: run.cwd,
          route: run.routing?.route,
        },
        fg,
      ),
      0,
      0,
    ),
  );
  if (run.scope?.length)
    container.addChild(
      new Text(
        fg(
          'muted',
          `${run.allowWrites ? 'Enforced' : 'Advisory'} scope: ${run.scope.join(', ')}`,
        ),
        0,
        0,
      ),
    );
  if (run.contextNote?.trim())
    container.addChild(
      new Text(fg('muted', `Parent note: ${run.contextNote.trim()}`), 0, 0),
    );
  for (const warning of [run.routing?.warning, ...(run.warnings ?? [])].filter(
    (value): value is string => Boolean(value),
  ))
    container.addChild(new Text(fg('warning', warning), 0, 0));

  const isolation = isolationLines(run);
  if (isolation.length) {
    container.addChild(new Spacer(1));
    container.addChild(sectionTitle('Isolation & patch', theme));
    container.addChild(new Text(isolation.join('\n'), 0, 0));
  }

  const activities = activityLines(run, fg);
  if (activities) {
    container.addChild(new Spacer(1));
    container.addChild(sectionTitle('Activity', theme));
    container.addChild(new Text(activities, 0, 0));
  }

  const final = getFinalAssistantText(run.messages).trim();
  if (!hasResultHeading(final))
    container.addChild(sectionTitle('Result', theme));
  if (final) container.addChild(new Markdown(final, 0, 0, mdTheme));
  else if (['queued', 'running'].includes(state))
    container.addChild(
      new Text(fg('muted', 'Waiting for the subagent…'), 0, 0),
    );
  else
    container.addChild(
      new Text(
        fg(
          state === 'error' ? 'error' : 'warning',
          run.errorMessage || run.stderr.trim() || 'No final response',
        ),
        0,
        0,
      ),
    );

  const stats = usage(run);
  if (stats || run.continuation) {
    container.addChild(new Spacer(1));
    container.addChild(sectionTitle('Usage & continuation', theme));
    if (stats) container.addChild(new Text(fg('dim', stats), 0, 0));
    if (run.continuation)
      container.addChild(
        new Text(fg('dim', `Continuation: ${run.continuation}`), 0, 0),
      );
  }
}

export function renderDelegateResult(
  toolResult: ToolResultLike,
  { expanded }: { expanded: boolean },
  theme: ThemeLike,
) {
  const details = getDetails(toolResult);
  if (!details?.runs?.length) return new Text(fallbackText(toolResult), 0, 0);

  const fg = theme.fg.bind(theme);
  const states = details.runs.map(getRunState);
  const complete = states.filter(
    (state) => !(['queued', 'running'] as DelegateRunState[]).includes(state),
  ).length;
  const succeeded = states.filter((state) => state === 'success').length;

  if (expanded) {
    const container = new Container();
    const title =
      details.mode === 'parallel'
        ? `Delegate · ${succeeded}/${details.runs.length} succeeded · ${complete}/${details.runs.length} complete`
        : `Delegate · ${stateLabel(details.runs[0])}`;
    container.addChild(new Text(fg('toolTitle', theme.bold(title)), 0, 0));
    for (const [index, run] of details.runs.entries()) {
      if (index > 0) container.addChild(new Spacer(1));
      addExpandedRun(
        container,
        run,
        theme,
        details.mode === 'parallel' ? `Subagent ${index + 1}` : undefined,
      );
    }
    return container;
  }

  if (details.mode === 'single') {
    const run = details.runs[0];
    const state = getRunState(run);
    const container = new Container();
    container.addChild(
      new Text(
        `${icon(run, fg)} ${fg('toolTitle', theme.bold('Delegate'))} ${fg(stateColor(state), `· ${stateLabel(run)}`)}`,
        0,
        0,
      ),
    );
    container.addChild(
      new Text(fieldLine('Task', taskText(run.task, false), fg, 'text'), 0, 0),
    );
    for (const line of currentActivityLines(run, fg))
      container.addChild(new Text(line, 0, 0));

    const final = getFinalAssistantText(run.messages).trim();
    if (final) {
      if (!hasResultHeading(final))
        container.addChild(sectionTitle('Result', theme));
      container.addChild(
        new Markdown(markdownPreview(final), 0, 0, getMarkdownTheme()),
      );
    } else if (['error', 'aborted', 'timed-out'].includes(state)) {
      container.addChild(
        new Text(
          fieldLine(
            'Error',
            truncate(
              run.errorMessage || run.stderr || stateLabel(run),
              ACTIVITY_PREVIEW_CHARS,
            ),
            fg,
            state === 'error' ? 'error' : 'warning',
          ),
          0,
          0,
        ),
      );
    }

    container.addChild(
      new Text(
        fieldLine(
          'Mode',
          modeDescription(
            {
              context: run.context,
              continuation:
                run.context === 'continuation' ? run.continuation : undefined,
              allowWrites: run.allowWrites,
              cwd: run.cwd,
              route: run.routing?.route,
            },
            fg,
          ),
          fg,
          null,
        ),
        0,
        0,
      ),
    );
    for (const warning of [
      run.routing?.warning,
      ...(run.warnings ?? []),
    ].filter((value): value is string => Boolean(value)))
      container.addChild(new Text(fg('warning', warning), 0, 0));
    const isolation = isolationLines(run);
    if (isolation.length)
      container.addChild(
        new Text(
          fieldLine(
            'Patch',
            isolation.slice(0, 2).join(' · '),
            fg,
            run.isolation?.status === 'patch-ready' ? 'warning' : 'dim',
          ),
          0,
          0,
        ),
      );
    const footer = [usage(run), controls([run])].filter(Boolean).join(' · ');
    container.addChild(new Text(fg('dim', footer), 0, 0));
    return container;
  }

  const container = new Container();
  container.addChild(
    new Text(
      `${fg('toolTitle', theme.bold('Delegate'))} ${fg(
        succeeded === details.runs.length
          ? 'success'
          : complete === details.runs.length
            ? 'warning'
            : 'accent',
        `· ${succeeded}/${details.runs.length} succeeded`,
      )} ${fg('muted', `· ${complete}/${details.runs.length} complete`)}`,
      0,
      0,
    ),
  );
  if (
    complete === details.runs.length &&
    succeeded > 0 &&
    succeeded < details.runs.length
  )
    container.addChild(
      new Text(
        fg('warning', 'Partial success — open details for diagnostics.'),
        0,
        0,
      ),
    );
  const warnings = [
    ...new Set(
      details.runs.flatMap((run) => [
        ...(run.warnings ?? []),
        ...(run.routing?.warning ? [run.routing.warning] : []),
      ]),
    ),
  ];
  for (const warning of warnings)
    container.addChild(
      new Text(
        fg('warning', `Warning: ${truncate(warning, RESULT_PREVIEW_CHARS)}`),
        0,
        0,
      ),
    );

  for (const [index, run] of details.runs.entries()) {
    const state = getRunState(run);
    container.addChild(
      new Text(
        `${fg('muted', `${index + 1}`.padStart(2))} ${icon(run, fg)} ${fg('text', taskText(run.task, false))}`,
        0,
        0,
      ),
    );
    container.addChild(
      new Text(
        `${fg('dim', '     ')}${fg(stateColor(state), capitalize(stateLabel(run)))}`,
        0,
        0,
      ),
    );
    container.addChild(
      new Text(
        `${fg('dim', '     Mode: ')}${modeDescription(
          {
            context: run.context,
            continuation:
              run.context === 'continuation' ? run.continuation : undefined,
            allowWrites: run.allowWrites,
            cwd: run.cwd,
            route: run.routing?.route,
          },
          fg,
        )}`,
        0,
        0,
      ),
    );
    if (['queued', 'running'].includes(state)) {
      const latest = run.activities.at(-1);
      container.addChild(
        new Text(
          `${fg('dim', '     ')}${fg('muted', latest ? 'Now: ' : 'Status: ')}${
            latest
              ? activityLabel(
                  {
                    ...latest,
                    label: truncate(latest.label, TASK_PREVIEW_CHARS),
                  },
                  fg,
                )
              : fg(
                  'dim',
                  state === 'queued'
                    ? 'Waiting for a slot'
                    : 'Starting subagent',
                )
          }`,
          0,
          0,
        ),
      );
    }
    if (['error', 'aborted', 'timed-out'].includes(state))
      container.addChild(
        new Text(
          `${fg('dim', '     ')}${fg(
            state === 'error' ? 'error' : 'warning',
            truncate(
              run.errorMessage || run.stderr || stateLabel(run),
              RESULT_PREVIEW_CHARS,
            ),
          )}`,
          0,
          0,
        ),
      );
  }
  container.addChild(new Text(fg('dim', controls(details.runs)), 0, 0));
  return container;
}
