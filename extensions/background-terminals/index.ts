import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { StringEnum } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { formatCompletion, formatPeek, formatSummary } from './format';
import {
  BackgroundManager,
  type BackgroundSnapshot,
  type BackgroundStatus,
} from './manager';

const WIDGET_KEY = 'background-terminals';
const DEFAULT_TAIL_LINES = 40;
const registered = new WeakSet<object>();

const Parameters = Type.Object({
  action: StringEnum(['start', 'peek', 'list', 'stop'] as const, {
    description: 'Operation to perform',
  }),
  command: Type.Optional(
    Type.String({ description: 'Shell command for start' }),
  ),
  title: Type.Optional(
    Type.String({ description: 'Short recognizable label for start' }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: 'Working directory for start; defaults to cwd',
    }),
  ),
  id: Type.Optional(Type.String({ description: 'Process id for peek' })),
  ids: Type.Optional(
    Type.Array(Type.String(), { description: 'Process ids for stop' }),
  ),
  wait_seconds: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 120,
      description:
        'For peek, wait up to this long for settlement before inspecting',
    }),
  ),
  tail_lines: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 200,
      description: 'Output lines per stream returned by peek; default 40',
    }),
  ),
});

function requireText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function validateCwd(base: string, requested?: string): string {
  const cwd = resolve(base, requested ?? '.');
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`cwd is not a directory: ${cwd}`);
  }
  return cwd;
}

interface ProcessDetails {
  readonly id: string;
  readonly title: string;
  readonly status: BackgroundStatus;
  readonly pid?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

interface BackgroundToolDetails {
  readonly action: 'start' | 'peek' | 'list' | 'stop';
  readonly process?: ProcessDetails;
  readonly processes?: ProcessDetails[];
}

function processDetails(snapshot: BackgroundSnapshot): ProcessDetails {
  return {
    id: snapshot.id,
    title: snapshot.title,
    status: snapshot.status,
    pid: snapshot.pid,
    exitCode: snapshot.exitCode,
    signal: snapshot.signal,
    stdoutBytes: snapshot.stdout.totalBytes,
    stderrBytes: snapshot.stderr.totalBytes,
  };
}

function resultText(
  content: ReadonlyArray<{ type: string; text?: string }>,
): string {
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

export default function backgroundTerminals(pi: ExtensionAPI): void {
  if (registered.has(pi)) return;
  registered.add(pi);

  let manager: BackgroundManager | undefined;
  let ui: ExtensionUIContext | undefined;
  let widgetCount = -1;

  const updateWidget = (force = false) => {
    if (!ui || !manager) return;
    const count = manager.runningCount;
    if (!force && count === widgetCount) return;
    try {
      ui.setWidget(
        WIDGET_KEY,
        count === 0
          ? undefined
          : (_tui, theme) => ({
              invalidate() {},
              render(width: number) {
                const line =
                  theme.fg('warning', '■ ') +
                  theme.fg(
                    'text',
                    `${count} background process${count === 1 ? '' : 'es'} running`,
                  ) +
                  theme.fg('dim', ' · ') +
                  theme.fg('accent', '/ps');
                return [truncateToWidth(line, width, '…')];
              },
            }),
      );
      // Cache only successful registrations; transient UI failures must retry.
      widgetCount = count;
    } catch {
      // UI can disappear during dialogs and session teardown.
    }
  };

  const deliverCompletion = (snapshot: BackgroundSnapshot) => {
    try {
      pi.sendMessage(
        {
          customType: 'background-terminal-result',
          content: formatCompletion(snapshot),
          display: true,
          details: {
            id: snapshot.id,
            title: snapshot.title,
            status: snapshot.status,
            exitCode: snapshot.exitCode,
            signal: snapshot.signal,
          },
        },
        { deliverAs: 'steer', triggerTurn: true },
      );
    } catch (error) {
      console.error(
        'background-terminals: failed to deliver completion',
        error,
      );
    }
  };

  const createManager = () =>
    new BackgroundManager({
      onSettled: deliverCompletion,
      onChange: updateWidget,
    });

  const getManager = () => {
    manager ??= createManager();
    return manager;
  };

  pi.on('session_start', (_event, ctx) => {
    ui = ctx.hasUI ? ctx.ui : undefined;
    manager ??= createManager();
    widgetCount = -1;
    updateWidget();
  });

  // Dialogs and occasional TUI rebuilds can drop widget components. Reassert
  // the keyed widget at stable agent boundaries even when the count is unchanged.
  pi.on('agent_start', () => updateWidget(true));
  pi.on('agent_settled', () => updateWidget(true));

  pi.on('session_shutdown', async () => {
    const closing = manager;
    manager = undefined;
    try {
      ui?.setWidget(WIDGET_KEY, undefined);
    } catch {
      // UI can already be unavailable.
    }
    ui = undefined;
    widgetCount = -1;
    await closing?.dispose();
  });

  pi.registerTool<typeof Parameters, BackgroundToolDetails>({
    name: 'background',
    label: 'Background Process',
    description:
      'Manage long-running, non-interactive Bash commands. Use start for servers, watchers, and long builds; use regular bash for quick commands. Commands run with /bin/bash -c (bash.exe on Windows), receive no stdin, and are stopped when the session ends. peek optionally waits for settlement, then returns bounded recent stdout/stderr so you can verify progress instead of guessing. Completion is delivered automatically: it steers the next turn when busy and wakes the agent when idle. Actions: start, peek, list, stop.',
    promptSnippet:
      'Start, inspect, and stop long-running non-interactive Bash commands',
    parameters: Parameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const active = getManager();

      switch (params.action) {
        case 'start': {
          const command = requireText(params.command, 'command');
          const title =
            requireText(params.title, 'title')
              .replace(/\s+/g, ' ')
              .slice(0, 80) || 'process';
          const cwd = validateCwd(ctx.cwd, params.cwd);
          const snapshot = active.start({ command, title, cwd });
          return {
            content: [
              {
                type: 'text',
                text: `Started ${snapshot.id} "${snapshot.title}" (pid ${snapshot.pid ?? '?'}). Completion will be delivered automatically; use background peek to wait and inspect output.`,
              },
            ],
            details: { action: 'start', process: processDetails(snapshot) },
          };
        }
        case 'peek': {
          const id = requireText(params.id, 'id');
          const waited = params.wait_seconds ?? 0;
          const snapshot = await active.peek(id, waited * 1000, signal);
          return {
            content: [
              {
                type: 'text',
                text: formatPeek(
                  snapshot,
                  params.tail_lines ?? DEFAULT_TAIL_LINES,
                  waited,
                ),
              },
            ],
            details: { action: 'peek', process: processDetails(snapshot) },
          };
        }
        case 'list': {
          const snapshots = active.list();
          return {
            content: [
              {
                type: 'text',
                text:
                  snapshots.length === 0
                    ? 'No background processes.'
                    : snapshots.map(formatSummary).join('\n'),
              },
            ],
            details: {
              action: 'list',
              processes: snapshots.map(processDetails),
            },
          };
        }
        case 'stop': {
          const ids = params.ids?.map((id) => id.trim()).filter(Boolean) ?? [];
          if (ids.length === 0) throw new Error('ids is required.');
          const snapshots = await active.stop(ids, signal);
          return {
            content: [
              {
                type: 'text',
                text: snapshots.map(formatSummary).join('\n'),
              },
            ],
            details: {
              action: 'stop',
              processes: snapshots.map(processDetails),
            },
          };
        }
      }
    },
    renderCall(args, theme, context) {
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
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details;
      if (expanded) return new Text(resultText(result.content), 0, 0);
      if (!details) {
        return new Text(
          theme.fg(
            'error',
            truncateToWidth(resultText(result.content), 96, '…'),
          ),
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
    },
  });

  pi.registerMessageRenderer(
    'background-terminal-result',
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        status?: BackgroundStatus;
      };
      const failed = details.status === 'failed';
      const stopped = details.status === 'killed';
      const icon = failed ? '✗' : stopped ? '■' : '✓';
      const color = failed ? 'error' : stopped ? 'muted' : 'success';
      const content =
        typeof message.content === 'string' ? message.content : '';
      return new Text(
        theme.fg(color, `${icon} `) +
          theme.fg(
            'muted',
            expanded ? content : truncateToWidth(content, 120, '…'),
          ),
        0,
        0,
      );
    },
  );

  pi.registerCommand('ps', {
    description: 'List and inspect background processes',
    handler: async (_args, ctx) => {
      const active = getManager();
      const snapshots = active.list();
      if (snapshots.length === 0) {
        if (ctx.hasUI) ctx.ui.notify('No background processes.', 'info');
        return;
      }

      if (ctx.mode !== 'tui') {
        if (ctx.hasUI) {
          ctx.ui.notify(snapshots.map(formatSummary).join('\n'), 'info');
        }
        return;
      }

      try {
        const labels = snapshots.map(formatSummary);
        const selected = await ctx.ui.select('Background processes', labels);
        if (!selected) return;
        const index = labels.indexOf(selected);
        const snapshot = snapshots[index];
        if (snapshot) {
          ctx.ui.notify(formatPeek(snapshot, 20), 'info');
        }
      } finally {
        updateWidget(true);
      }
    },
  });
}
