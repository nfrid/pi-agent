import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import {
  type BackgroundCompletionCard,
  renderBackgroundCompletion,
} from '../shared/ui/background-completion';
import type { BackgroundStatus } from './manager';
import { type BackgroundToolDetails, RESULT_MESSAGE_TYPE } from './schema';

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
    wait_seconds?: number;
  },
  theme: Theme,
  context?: { expanded?: boolean },
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
      const label = args.title
        ? ` ${theme.fg('accent', truncateToWidth(args.title, 32, '…'))}`
        : '';
      const command = args.command?.trim() ?? '';
      const shown = expanded
        ? command
        : truncateToWidth(command.replace(/\s+/g, ' '), 72, '…');
      return new Text(
        `${title}${label}${shown ? `\n${theme.fg('dim', `$ ${shown}`)}` : ''}`,
        0,
        0,
      );
    }
    case 'peek': {
      const wait = args.wait_seconds
        ? theme.fg('dim', ` · wait ${args.wait_seconds}s`)
        : '';
      return new Text(
        `${title} ${theme.fg('accent', args.id ?? '?')}${wait}`,
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
      return new Text(
        `${title} ${visible.map((id) => theme.fg('accent', id)).join(', ')}${suffix}`,
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
  if (expanded) return new Text(resultText(result.content), 0, 0);
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
      .map((process) => `${process.id} ${process.status}`)
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
    theme.fg(color, `${icon} ${process.id} ${process.status}`) +
      theme.fg('dim', ` · ${process.title}${running ? '' : ` · ${exit}`}`),
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
      { text: details.title ?? details.id ?? 'finished', color: 'text' },
      ...(metadata
        ? ([{ text: ` · ${metadata}`, color: 'dim' }] as const)
        : []),
    ],
    rows: details.id
      ? [
          {
            icon: style.icon,
            color: style.color,
            segments: [
              { text: details.id, color: 'accent' },
              ...(outcome
                ? ([{ text: ` · ${outcome}`, color: 'dim' }] as const)
                : []),
            ],
          },
        ]
      : undefined,
  };
}

export function registerBackgroundMessageRenderer(pi: ExtensionAPI): void {
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
