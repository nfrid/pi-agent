import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui';
import { ensureDelegateLifecycle } from './lifecycle';
import { blockedQuestion } from './output';
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
  worktreeLines,
} from './render-utils';
import {
  getDelegateResultSpec,
  getSettledDelegateResult,
} from './structured-result';
import type { DelegatedRun, DelegateRunState } from './types';
import {
  continuationRecoveryNote,
  getFinalAssistantText,
  getRunState,
} from './types';

function isBackgroundLaunch(run: DelegatedRun): boolean {
  return (
    Boolean(run.backgroundJobId) &&
    ['queued', 'running'].includes(getRunState(run))
  );
}

function backgroundLaunchLabel(run: DelegatedRun): string {
  return `${capitalize(getRunState(run))} · ${run.backgroundJobId ?? '?'} · Background`;
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
          isolation: run.isolation,
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
          // Scope is guidance for the child in both directions now; nothing
          // enforces it, so the label no longer claims otherwise.
          `Expected scope: ${run.scope.join(', ')}`,
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

  const worktree = worktreeLines(run);
  if (worktree.length) {
    container.addChild(new Spacer(1));
    container.addChild(sectionTitle('Branch', theme));
    container.addChild(new Text(worktree.join('\n'), 0, 0));
  }
  const recoveryNote = continuationRecoveryNote(run);
  if (recoveryNote)
    container.addChild(new Text(fg('muted', recoveryNote), 0, 0));

  const structured = getDelegateResultSpec(run);
  const lifecycle = ensureDelegateLifecycle(run);
  const final = structured ? '' : getFinalAssistantText(run.messages).trim();
  const backgroundLaunch = isBackgroundLaunch(run);
  const blocked = blockedQuestion(run);
  if (blocked) {
    container.addChild(new Spacer(1));
    container.addChild(sectionTitle('Blocked on', theme));
    container.addChild(new Text(fg('warning', blocked), 0, 0));
  }
  if (!hasResultHeading(final))
    container.addChild(sectionTitle('Result', theme));
  if (lifecycle) {
    container.addChild(
      new Text(
        fg(
          state === 'error' ? 'error' : 'warning',
          `Observed failure: ${lifecycle.reason}`,
        ),
        0,
        0,
      ),
    );
    container.addChild(
      new Text(
        fg(
          'warning',
          lifecycle.diagnostic
            ? `Diagnostic: ${lifecycle.diagnostic}`
            : lifecycle.diagnosticArtifact
              ? `Diagnostic artifact: ${lifecycle.diagnosticArtifact.handle}`
              : 'Diagnostic artifact unavailable.',
        ),
        0,
        0,
      ),
    );
    container.addChild(
      new Text(
        fg(
          'dim',
          `Continuation usable: ${lifecycle.continuationUsable ? 'yes' : 'no'} · Writable branch retained: ${lifecycle.writableBranchRetained ? 'yes' : 'no'} · Read-only snapshot retained: ${lifecycle.readOnlySnapshotRetained ? 'yes' : 'no'}`,
        ),
        0,
        0,
      ),
    );
  } else if (structured) {
    const settlement = getSettledDelegateResult(run);
    container.addChild(
      new Text(
        fg(
          settlement?.valid ? 'success' : 'warning',
          settlement?.valid
            ? 'Structured result valid; selected projections are in the parent handoff.'
            : `Structured result invalid${run.errorMessage ? `: ${run.errorMessage}` : '.'}`,
        ),
        0,
        0,
      ),
    );
  } else if (final) container.addChild(new Markdown(final, 0, 0, mdTheme));
  else if (backgroundLaunch)
    container.addChild(
      new Text(fg('muted', 'Running independently in the background.'), 0, 0),
    );
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

  const activities = backgroundLaunch ? '' : activityLines(run, fg);
  const stats = usage(run);
  container.addChild(new Spacer(1));
  container.addChild(sectionTitle('Runtime', theme));
  if (activities) container.addChild(new Text(activities, 0, 0));
  container.addChild(
    new Text(
      backgroundLaunch
        ? fg('muted', backgroundLaunchLabel(run))
        : fg(stateColor(state), capitalize(runtimeLabel(run))),
      0,
      0,
    ),
  );
  if (stats) container.addChild(new Text(fg('dim', stats), 0, 0));
  if (run.backgroundJobId)
    container.addChild(
      new Text(fg('accent', `Background job: ${run.backgroundJobId}`), 0, 0),
    );
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
        `${icon(run, fg)} ${fg('toolTitle', theme.bold('Delegate'))} ${fg(stateColor(state), `· ${isBackgroundLaunch(run) ? backgroundLaunchLabel(run) : stateLabel(run)}`)}`,
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
              isolation: run.isolation,
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
    const worktree = worktreeLines(run);
    if (worktree.length)
      container.addChild(
        new Text(
          fieldLine(
            'Branch',
            worktree.slice(0, 2).join(' · '),
            fg,
            run.worktree?.hasWork ? 'warning' : 'dim',
          ),
          0,
          0,
        ),
      );
    const recoveryNote = continuationRecoveryNote(run);
    if (recoveryNote)
      container.addChild(
        new Text(fieldLine('Note', recoveryNote, fg, 'dim'), 0, 0),
      );

    const blocked = blockedQuestion(run);
    if (blocked)
      container.addChild(
        new Text(
          fieldLine(
            'Blocked',
            truncate(blocked, RESULT_PREVIEW_CHARS),
            fg,
            'warning',
          ),
          0,
          0,
        ),
      );

    const structured = getDelegateResultSpec(run);
    const lifecycle = ensureDelegateLifecycle(run);
    const final = structured ? '' : getFinalAssistantText(run.messages).trim();
    if (lifecycle) {
      container.addChild(
        new Text(fieldLine('Failure', lifecycle.reason, fg, 'error'), 0, 0),
      );
      container.addChild(
        new Text(
          fieldLine(
            'Diagnostic',
            lifecycle.diagnostic ??
              (lifecycle.diagnosticArtifact
                ? `artifact ${lifecycle.diagnosticArtifact.handle}`
                : 'artifact unavailable'),
            fg,
            'warning',
          ),
          0,
          0,
        ),
      );
    } else if (structured) {
      const settlement = getSettledDelegateResult(run);
      container.addChild(
        new Text(
          fieldLine(
            'Result',
            settlement?.valid
              ? 'structured result valid'
              : 'structured result invalid',
            fg,
            settlement?.valid ? 'success' : 'warning',
          ),
          0,
          0,
        ),
      );
    } else if (final) {
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

    if (!isBackgroundLaunch(run))
      for (const line of currentActivityLines(run, fg))
        container.addChild(new Text(line, 0, 0));
    const footer = (
      isBackgroundLaunch(run)
        ? [
            `job ${run.backgroundJobId}`,
            'background',
            controls([run], { includeCancel: false }),
          ]
        : [runtimeLabel(run), usage(run), controls([run])]
    )
      .filter(Boolean)
      .join(' · ');
    container.addChild(new Text(fg('dim', footer), 0, 0));
    return container;
  }

  const backgroundLaunch = details.runs.every(isBackgroundLaunch);
  const container = new Container();
  container.addChild(
    new Text(
      `${fg('toolTitle', theme.bold('Delegate'))} ${fg('muted', `· ${details.runs.length} subagents`)}${backgroundLaunch ? fg('warning', ' · background') : ''}`,
      0,
      0,
    ),
  );
  if (
    !backgroundLaunch &&
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
            isolation: run.isolation,
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
    const status = fg(
      stateColor(state),
      isBackgroundLaunch(run)
        ? backgroundLaunchLabel(run)
        : capitalize(runtimeLabel(run)),
    );
    const activity =
      !isBackgroundLaunch(run) && ['queued', 'running'].includes(state)
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
        `${fg('dim', `${index + 1}`.padStart(2))} ${status}${!isBackgroundLaunch(run) && run.backgroundJobId ? fg('accent', ` · ${run.backgroundJobId}`) : ''}${activity}`,
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
    const recoveryNote = continuationRecoveryNote(run);
    if (recoveryNote)
      container.addChild(
        new Text(`${fg('dim', '   ')}${fg('dim', recoveryNote)}`, 0, 0),
      );
  }
  const summary = backgroundLaunch
    ? `${details.runs.length} background job${details.runs.length === 1 ? '' : 's'} started`
    : `${succeeded}/${details.runs.length} succeeded · ${complete}/${details.runs.length} complete`;
  container.addChild(
    new Text(
      fg(
        backgroundLaunch
          ? 'dim'
          : succeeded === details.runs.length
            ? 'success'
            : complete === details.runs.length
              ? 'warning'
              : 'dim',
        `${summary} · ${controls(details.runs, { includeCancel: !backgroundLaunch })}`,
      ),
      0,
      0,
    ),
  );
  return container;
}
