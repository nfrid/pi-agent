import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui';
import {
  ACTIVITY_PREVIEW_CHARS,
  activityLabel,
  activityLines,
  capitalize,
  controls,
  currentActivityLines,
  fallbackText,
  fieldLine,
  getDetails,
  getMarkdownTheme,
  hasResultHeading,
  icon,
  indexedTaskBlock,
  isolationLines,
  markdownPreview,
  modeDescription,
  RESULT_PREVIEW_CHARS,
  runtimeLabel,
  sectionTitle,
  stateColor,
  stateLabel,
  TASK_PREVIEW_CHARS,
  type ThemeLike,
  type ToolResultLike,
  taskBlock,
  truncate,
  usage,
} from './render-utils';
import type { DelegatedRun, DelegateRunState } from './types';
import { getFinalAssistantText, getRunState } from './types';

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
      new Text(`${icon(run, fg)} ${fg('toolTitle', theme.bold(label))}`, 0, 0),
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

  const activities = activityLines(run, fg);
  const stats = usage(run);
  container.addChild(new Spacer(1));
  container.addChild(sectionTitle('Runtime', theme));
  if (activities) container.addChild(new Text(activities, 0, 0));
  container.addChild(
    new Text(fg(stateColor(state), capitalize(runtimeLabel(run))), 0, 0),
  );
  if (stats) container.addChild(new Text(fg('dim', stats), 0, 0));
  if (run.continuation)
    container.addChild(
      new Text(fg('dim', `Continuation: ${run.continuation}`), 0, 0),
    );
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
        ? `Delegate · ${details.runs.length} subagents`
        : 'Delegate';
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
    container.addChild(taskBlock('Task', run.task, false, fg));

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

    for (const line of currentActivityLines(run, fg))
      container.addChild(new Text(line, 0, 0));
    const footer = [runtimeLabel(run), usage(run), controls([run])]
      .filter(Boolean)
      .join(' · ');
    container.addChild(new Text(fg('dim', footer), 0, 0));
    return container;
  }

  const container = new Container();
  container.addChild(
    new Text(
      `${fg('toolTitle', theme.bold('Delegate'))} ${fg('muted', `· ${details.runs.length} subagents`)}`,
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
    container.addChild(
      indexedTaskBlock(
        `${fg('muted', `${index + 1}`.padStart(2))} ${icon(run, fg)} `,
        run.task,
        fg,
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
  }

  // Frequently changing runtime data stays at the bottom so updates do not
  // repaint or shift the task summaries above it.
  for (const [index, run] of details.runs.entries()) {
    const state = getRunState(run);
    const latest = run.activities.at(-1);
    const status = fg(stateColor(state), capitalize(runtimeLabel(run)));
    const activity = ['queued', 'running'].includes(state)
      ? latest
        ? ` · ${activityLabel(
            {
              ...latest,
              label: truncate(latest.label, TASK_PREVIEW_CHARS),
            },
            fg,
          )}`
        : fg(
            'dim',
            ` · ${state === 'queued' ? 'Waiting for a slot' : 'Starting subagent'}`,
          )
      : '';
    container.addChild(
      new Text(
        `${fg('dim', `${index + 1}`.padStart(2))} ${status}${activity}`,
        0,
        0,
      ),
    );
    if (['error', 'aborted', 'timed-out'].includes(state))
      container.addChild(
        new Text(
          `${fg('dim', '   ')}${fg(
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
  const summary = `${succeeded}/${details.runs.length} succeeded · ${complete}/${details.runs.length} complete`;
  container.addChild(
    new Text(
      fg(
        succeeded === details.runs.length
          ? 'success'
          : complete === details.runs.length
            ? 'warning'
            : 'dim',
        `${summary} · ${controls(details.runs)}`,
      ),
      0,
      0,
    ),
  );
  return container;
}
