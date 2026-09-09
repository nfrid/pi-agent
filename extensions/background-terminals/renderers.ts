import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import {
  type BackgroundCompletionCard,
  renderBackgroundCompletion,
} from '../shared/ui/background-completion';
import type { BackgroundStatus, EndedWatch } from './manager';
import {
  type BackgroundToolDetails,
  RESULT_MESSAGE_TYPE,
  WATCH_RESULT_MESSAGE_TYPE,
} from './schema';

export function resultText(
  content: ReadonlyArray<{ type: string; text?: string }>,
): string {
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

export function renderBackgroundCall(
  args: {
    action?: string;
    title?: string;
    command?: string;
    id?: string;
    ids?: string[];
    watch_ids?: string[];
  },
  theme: Theme,
  context?: { expanded?: boolean },
  resolveProcess?: (id: string) =>
    | {
        title: string;
        watches?: readonly {
          id: string;
          contains: string;
          stream?: 'stdout' | 'stderr';
        }[];
      }
    | undefined,
) {
  // Arguments are partial while a tool call streams. Always return a
  // component, even before `action` has arrived, or the TUI Box receives
  // an undefined child and crashes during rendering.
  const action = args.action ?? '';
  const expanded = context?.expanded === true;
  const title =
    theme.fg('toolTitle', theme.bold('background')) +
    (action ? ` ${theme.fg('muted', action)}` : '');

  switch (action) {
    case 'start': {
      const command = args.command?.trim() ?? '';
      const processTitle =
        args.title?.trim() ||
        command
          .split(/[\r\n]/u, 1)[0]
          ?.replace(/\s+/gu, ' ')
          .slice(0, 80) ||
        'Background process';
      const label = ` ${theme.fg('accent', truncateToWidth(processTitle, 32, '…'))}`;
      const shown = expanded
        ? command
        : truncateToWidth(command.replace(/\s+/g, ' '), 72, '…');
      return new Text(
        `${title}${label}${shown ? `\n${theme.fg('dim', `$ ${shown}`)}` : ''}`,
        0,
        0,
      );
    }
    case 'peek':
    case 'watch': {
      const process = args.id ? resolveProcess?.(args.id) : undefined;
      return new Text(
        `${title} ${theme.fg('accent', process?.title ?? 'Background process')}`,
        0,
        0,
      );
    }
    case 'list':
      return new Text(title, 0, 0);
    case 'stop': {
      const ids = args.ids ?? [];
      const visible = expanded ? ids : ids.slice(0, 3);
      const suffix =
        !expanded && ids.length > visible.length
          ? ` ${theme.fg('dim', `+${ids.length - visible.length}`)}`
          : '';
      const labels = visible.map(
        (id) => resolveProcess?.(id)?.title ?? 'Background process',
      );
      return new Text(
        `${title} ${labels.map((label) => theme.fg('accent', label)).join(', ')}${suffix}`,
        0,
        0,
      );
    }
    case 'unwatch': {
      const process = args.id ? resolveProcess?.(args.id) : undefined;
      const conditions = process?.watches
        ?.filter((watch) => args.watch_ids?.includes(watch.id))
        .map((watch) => JSON.stringify(watch.contains));
      return new Text(
        `${title} ${theme.fg('accent', process?.title ?? 'Background process')}${conditions?.length ? ` · ${conditions.join(', ')}` : ''}`,
        0,
        0,
      );
    }
    default:
      return new Text(title, 0, 0);
  }
}

export function renderBackgroundResult(
  result: {
    content: ReadonlyArray<{ type: string; text?: string }>;
    details?: BackgroundToolDetails;
  },
  { expanded }: { expanded: boolean },
  theme: Theme,
) {
  const details = result.details;
  if (expanded)
    return new Text(`Raw process result:\n${resultText(result.content)}`, 0, 0);
  if (!details) {
    return new Text(
      theme.fg('error', truncateToWidth(resultText(result.content), 96, '…')),
      0,
      0,
    );
  }

  if (details.action === 'list') {
    const processes = details.processes ?? [];
    const running = processes.filter(
      (process) => process.status === 'running',
    ).length;
    return new Text(
      theme.fg('muted', `• ${processes.length} tracked`) +
        theme.fg(running > 0 ? 'warning' : 'dim', ` · ${running} running`),
      0,
      0,
    );
  }

  if (details.action === 'stop') {
    const processes = details.processes ?? [];
    const killed = processes.filter(
      (process) => process.status === 'killed',
    ).length;
    const color =
      killed === processes.length
        ? 'success'
        : killed > 0
          ? 'warning'
          : 'muted';
    const states = processes
      .map(
        (process) =>
          `${process.title || 'Background process'} ${process.status}`,
      )
      .join(', ');
    return new Text(
      theme.fg(color, '■ stop complete') +
        (states
          ? theme.fg('dim', ` · ${truncateToWidth(states, 80, '…')}`)
          : ''),
      0,
      0,
    );
  }

  const process = details.process;
  if (!process) return new Text('', 0, 0);
  const running = process.status === 'running';
  const failed = process.status === 'failed';
  const icon = running ? '●' : failed ? '✗' : '✓';
  const color = running ? 'warning' : failed ? 'error' : 'success';
  const exit = process.signal
    ? process.signal
    : process.exitCode !== undefined
      ? `exit ${process.exitCode}`
      : process.status;
  return new Text(
    theme.fg(
      color,
      `${icon} ${process.title || 'Background process'} ${process.status}`,
    ) + (running ? '' : theme.fg('dim', ` · ${exit}`)),
    0,
    0,
  );
}

interface BackgroundCompletionDetails {
  readonly id?: string;
  readonly title?: string;
  readonly status?: BackgroundStatus;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly duration?: string;
  readonly outcome?: string;
  readonly endedWatches?: readonly EndedWatch[];
}

function completionCard(
  details: BackgroundCompletionDetails,
): BackgroundCompletionCard {
  const status = details.status;
  const style =
    status === 'failed'
      ? { icon: '✗', color: 'error' as const, label: 'failed' }
      : status === 'killed'
        ? { icon: '■', color: 'warning' as const, label: 'stopped' }
        : { icon: '✓', color: 'success' as const, label: 'finished' };
  const metadata = [style.label, details.duration].filter(Boolean).join(' · ');
  const outcome =
    details.signal ??
    (details.exitCode !== undefined ? `exit ${details.exitCode}` : undefined) ??
    details.outcome;
  return {
    icon: style.icon,
    color: style.color,
    title: [
      { text: 'Background process ', color: 'muted' },
      { text: details.title ?? 'Background process', color: 'text' },
      ...(metadata
        ? ([{ text: ` · ${metadata}`, color: 'dim' }] as const)
        : []),
    ],
    rows: [
      {
        icon: style.icon,
        color: style.color,
        segments: [
          { text: details.title ?? 'Background process', color: 'text' },
          ...(outcome
            ? ([{ text: ` · ${outcome}`, color: 'dim' }] as const)
            : []),
        ],
      },
      ...(details.endedWatches?.length
        ? [
            {
              icon: '·',
              color: 'warning' as const,
              segments: [
                {
                  text: `unmatched watches: ${details.endedWatches
                    .map(
                      (watch) =>
                        `${JSON.stringify(watch.contains)}${watch.stream ? ` (${watch.stream})` : ''}`,
                    )
                    .join(', ')}`,
                  color: 'dim' as const,
                },
              ],
            },
          ]
        : []),
    ],
  };
}

export function registerBackgroundMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(
    WATCH_RESULT_MESSAGE_TYPE,
    (message, { expanded, outputPad }, theme) => {
      const details = (message.details ?? {}) as {
        title?: string;
        status?: string;
        contains?: string;
        stream?: string;
        excerpt?: string;
      };
      const matched = details.status === 'matched';
      const color = matched ? ('success' as const) : ('warning' as const);
      const outcome = matched
        ? 'matched'
        : details.status === 'timed_out'
          ? 'timed out'
          : 'ended unmatched';
      return renderBackgroundCompletion(
        {
          icon: matched ? '✓' : '•',
          color,
          title: [
            { text: 'Background watch ', color: 'muted' },
            { text: details.title ?? 'Background process', color: 'text' },
            { text: ` · ${outcome}`, color: 'dim' },
          ],
          rows: [
            {
              icon: '·',
              color,
              segments: [
                {
                  text: `${JSON.stringify(details.contains ?? 'Output condition')}${details.stream ? ` (${details.stream})` : ''}`,
                  color: 'text',
                },
              ],
            },
            ...(details.excerpt
              ? [
                  {
                    icon: '·',
                    color,
                    segments: [
                      { text: details.excerpt, color: 'dim' as const },
                    ],
                  },
                ]
              : []),
          ],
        },
        { expanded, outputPad },
        theme,
      );
    },
  );
  pi.registerMessageRenderer(
    RESULT_MESSAGE_TYPE,
    (message, { expanded, outputPad }, theme) => {
      const details = (message.details ?? {}) as BackgroundCompletionDetails;
      return renderBackgroundCompletion(
        completionCard(details),
        { expanded, outputPad },
        theme,
      );
    },
  );
}
