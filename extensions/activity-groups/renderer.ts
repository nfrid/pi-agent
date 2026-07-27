import path from 'node:path';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { stringArg, toolBaseName, toolPath, toolRole } from './grouping';
import { composeTitle, describeTools, headersOf } from './title';
import type {
  SequenceItem,
  SequenceOptions,
  SequenceRenderer,
  SequenceSnapshot,
} from './types';

type ToolItem = Extract<SequenceItem, { type: 'tool' }>;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;
const MAX_COMMAND_WIDTH = 56;
const MAX_SUMMARY_COMMAND_WIDTH = 32;
const MAX_ACTIVITY_LINES = 3;

function displayPath(value: string, cwd: string): string {
  const relative = path
    .relative(cwd, path.resolve(cwd, value))
    .replace(/\\/g, '/');
  return relative && !relative.startsWith('../')
    ? relative
    : value.replace(/\\/g, '/');
}

/** One line naming what a single tool call is touching, for the live sub-line. */
function toolSubject(tool: ToolItem, cwd: string): string {
  const name = toolBaseName(tool.name);
  const target = toolPath(tool.args);
  if (name === 'bash' || name === 'inspect_shell') {
    const command = stringArg(tool.args, 'command');
    return command
      ? `${name === 'bash' ? 'Running' : 'Checking'} ${shortCommand(command, MAX_COMMAND_WIDTH)}`
      : 'Running command';
  }
  const pattern = stringArg(tool.args, 'pattern');
  if (pattern && (name === 'grep' || name === 'find' || name === 'glob'))
    return `Searching for ${pattern}${target ? ` in ${displayPath(target, cwd)}` : ''}`;
  if (!target) return `Running ${name}`;
  const shown = displayPath(target, cwd);
  if (name === 'read') return `Reading ${shown}`;
  if (name === 'ls') return `Listing ${shown}`;
  return `${name === 'write' ? 'Writing' : 'Editing'} ${shown}`;
}

/**
 * The directory the group's files share, when they share one. Naming the area
 * of the tree is what makes a collapsed group locatable at a glance.
 */
function commonDirectory(files: readonly string[]): string | undefined {
  if (files.length < 2) return undefined;
  const segments = files.map((file) => file.split('/').slice(0, -1));
  const [first = []] = segments;
  let shared = first.length;
  for (const other of segments)
    while (
      shared > 0 &&
      other.slice(0, shared).join('/') !== first.slice(0, shared).join('/')
    )
      shared -= 1;
  const directory = first.slice(0, shared).join('/');
  return directory || undefined;
}

/** Search patterns are regexes and can be enormous; show only the head. */
function shortPattern(value: string): string {
  return value.length > MAX_SUMMARY_COMMAND_WIDTH
    ? `${value.slice(0, MAX_SUMMARY_COMMAND_WIDTH)}…`
    : value;
}

/** "a.ts, b.ts and 3 more" — a readable list that never runs away. */
function list(values: readonly string[], limit: number): string {
  const shown = values.slice(0, limit);
  const extra = values.length - shown.length;
  const joined = shown.join(', ');
  return extra > 0 ? `${joined} and ${extra} more` : joined;
}

/**
 * The recognisable head of a command. Agents chain shell one-liners with `&&`
 * and pipes, and sixty characters of that is noise — what identifies the call
 * is how it starts, so everything past the first segment is dropped.
 */
function shortCommand(value: string, width: number): string {
  const head = (value.split('\n')[0] ?? value).split(/&&|\|\||[;|]/)[0]?.trim();
  if (!head) return 'command';
  return head.length > width ? `${head.slice(0, width).trimEnd()}…` : head;
}

/**
 * What the group actually did, in words. A count of calls says nothing about
 * whether the agent read the code or rewrote it, so the files it changed and
 * the commands it ran get named — those are the parts worth scanning for.
 * Ordered by how much they matter, and capped so a group stays a summary.
 */
function activityLines(
  tools: readonly ToolItem[],
  cwd: string,
  limit: number,
): string[] {
  const byRole = <T>(role: string, pick: (tool: ToolItem) => T | undefined) => [
    ...new Set(
      tools
        .filter((tool) => toolRole(tool.name) === role)
        .map(pick)
        .filter((value): value is T & {} => value !== undefined),
    ),
  ];

  const edited = byRole('edit', (tool) => {
    const target = toolPath(tool.args);
    return target
      ? (displayPath(target, cwd).split('/').at(-1) ?? '')
      : undefined;
  });
  const commands = byRole('command', (tool) => {
    const command = stringArg(tool.args, 'command');
    return command
      ? shortCommand(command, MAX_SUMMARY_COMMAND_WIDTH)
      : undefined;
  });
  const searches = byRole('search', (tool) => stringArg(tool.args, 'pattern'));
  const reads = tools.filter((tool) => toolRole(tool.name) === 'read').length;

  const lines: string[] = [];
  if (edited.length > 0) lines.push(`Edited ${list(edited, 4)}`);
  if (commands.length > 0) lines.push(`Ran ${list(commands, 2)}`);
  if (searches.length > 0)
    lines.push(`Searched for ${list(searches.map(shortPattern), 2)}`);
  if (reads > 0) lines.push(`Read ${count(reads, 'file')}`);
  return lines.slice(0, limit);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(1, Math.round(milliseconds))}ms`;
  if (milliseconds < 10_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function count(value: number, singular: string): string {
  return `${value} ${value === 1 ? singular : `${singular}s`}`;
}

export class ActivityGroupComponent implements Component {
  private sequence: SequenceSnapshot;
  private options: SequenceOptions;
  private spinnerFrame = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    sequence: SequenceSnapshot,
    options: SequenceOptions,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
  ) {
    this.sequence = sequence;
    this.options = options;
    this.updateSpinner();
  }

  update(sequence: SequenceSnapshot, options: SequenceOptions): void {
    this.sequence = sequence;
    this.options = options;
    this.updateSpinner();
  }

  invalidate(): void {
    this.options.defaultView.invalidate?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private updateSpinner(): void {
    if (!this.options.streaming) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.requestRender();
    }, SPINNER_INTERVAL_MS);
    this.timer.unref?.();
  }

  /**
   * Live groups are titled by the newest narration header, so the line tracks
   * the work as it moves. Settled groups compose the whole group's narration,
   * because by then the interesting thing is what the phase amounted to.
   */
  private title(tools: readonly ToolItem[], completed: boolean): string {
    const headers = this.sequence.items.flatMap((item) =>
      item.type === 'assistant' ? headersOf(item.message) : [],
    );
    const title = completed ? composeTitle(headers) : headers.at(-1);
    if (title) return title;
    const files = this.files(tools);
    return describeTools(tools, commonDirectory(files) ?? files[0], completed);
  }

  private files(tools: readonly ToolItem[]): string[] {
    return [
      ...new Set(
        tools
          .map((tool) => toolPath(tool.args))
          .filter((value): value is string => value !== undefined)
          .map((value) => displayPath(value, this.sequence.cwd)),
      ),
    ];
  }

  render(width: number): string[] {
    const tools = this.sequence.items.filter(
      (item): item is ToolItem => item.type === 'tool',
    );
    const completed = !this.options.streaming;
    const marker = completed
      ? this.sequence.failed
        ? '✗'
        : '✓'
      : SPINNER_FRAMES[this.spinnerFrame];
    const color = this.sequence.failed
      ? 'error'
      : completed
        ? 'success'
        : 'accent';

    const lines = [
      '',
      truncateToWidth(
        ` ${this.theme.fg(color, marker)} ${this.theme.fg('text', this.title(tools, completed))}`,
        width,
      ),
    ];

    if (!completed) {
      const running = [...tools]
        .reverse()
        .find((tool) => tool.status !== 'pending');
      const lastTool = running ?? tools.at(-1);
      if (lastTool)
        lines.push(
          truncateToWidth(
            `   ${this.theme.fg('muted', toolSubject(lastTool, this.sequence.cwd))}`,
            width,
          ),
        );
    }

    // Naming what was done is the point of a collapsed group; while it is
    // still live the sub-line above already carries the current call.
    for (const line of activityLines(
      tools,
      this.sequence.cwd,
      completed ? MAX_ACTIVITY_LINES : 1,
    ))
      lines.push(truncateToWidth(`   ${this.theme.fg('muted', line)}`, width));

    const files = this.files(tools);
    const directory = commonDirectory(files);
    // A group opens the moment the model commits to tool calls, so it can be
    // briefly empty while the first call is still streaming in.
    const metadata = tools.length > 0 ? [count(tools.length, 'call')] : [];
    if (files.length > 0)
      metadata.push(
        directory
          ? `${count(files.length, 'file')} in ${directory}`
          : count(files.length, 'file'),
      );
    if (completed && this.sequence.completedAt !== undefined)
      metadata.push(
        formatDuration(this.sequence.completedAt - this.sequence.startedAt),
      );
    const failed = tools.filter((tool) => tool.isError).length;
    if (failed > 0) metadata.push(`${failed} failed`);
    if (metadata.length > 0)
      lines.push(
        truncateToWidth(
          `   ${this.theme.fg(this.sequence.failed ? 'error' : 'muted', metadata.join(' · '))}`,
          width,
        ),
      );

    if (this.options.expanded)
      lines.push(...this.options.defaultView.render(width));
    return lines;
  }
}

/**
 * Build the renderer. Reuses the component across invocations for one sequence
 * so its spinner timer survives re-renders.
 */
export function createActivityGroupRenderer(): SequenceRenderer {
  return (sequence, options, theme, context) => {
    const existing = context.lastComponent;
    if (existing instanceof ActivityGroupComponent) {
      existing.update(sequence, options);
      return existing;
    }
    return new ActivityGroupComponent(sequence, options, theme, () =>
      context.requestRender(),
    );
  };
}
