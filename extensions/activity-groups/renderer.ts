import path from 'node:path';
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { stringArg, toolBaseName, toolPath, toolRole } from './grouping';
import {
  composeTitle,
  describeTools,
  headersOf,
  isNarration,
  stripEmphasis,
} from './title';
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
/** How many of a group's calls stay on screen. The rest become a count. */
const MAX_STEP_LINES = 3;
const STEP_MARKER = '⏺';

function displayPath(value: string, cwd: string): string {
  const relative = path
    .relative(cwd, path.resolve(cwd, value))
    .replace(/\\/g, '/');
  return relative && !relative.startsWith('../')
    ? relative
    : value.replace(/\\/g, '/');
}

/**
 * What a single call is doing, split where the eye wants to split it: the
 * action is the part worth reading down a column, the argument is the detail
 * you look at only once the action has caught your attention.
 */
function toolSubject(
  tool: ToolItem,
  cwd: string,
): { action: string; argument?: string } {
  const name = toolBaseName(tool.name);
  const target = toolPath(tool.args);
  if (name === 'bash' || name === 'inspect_shell') {
    const command = stringArg(tool.args, 'command');
    if (!command) return { action: 'Running command' };
    return {
      action: name === 'bash' ? 'Running' : 'Checking',
      argument: shortCommand(command, MAX_COMMAND_WIDTH),
    };
  }
  const pattern = stringArg(tool.args, 'pattern');
  if (pattern && (name === 'grep' || name === 'find' || name === 'glob'))
    return {
      action: 'Searching for',
      argument: `${pattern}${target ? ` in ${displayPath(target, cwd)}` : ''}`,
    };
  if (!target) return { action: `Running ${name}` };
  const argument = displayPath(target, cwd);
  if (name === 'read') return { action: 'Reading', argument };
  if (name === 'ls') return { action: 'Listing', argument };
  return { action: name === 'write' ? 'Writing' : 'Editing', argument };
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
 * The colour a step is marked in, so a glance down the group tells reading
 * from writing from running without reading a word of it.
 */
function roleColor(tool: ToolItem): ThemeColor {
  if (tool.isError) return 'error';
  switch (toolRole(tool.name)) {
    case 'edit':
      return 'warning';
    case 'command':
      return 'accent';
    case 'search':
      return 'muted';
    default:
      return 'dim';
  }
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
   *
   * A preamble outranks both. When the model announced this phase in its own
   * words to the user — "Now I'll check how sessions expire" — that sentence
   * *is* the group, and it is printed here rather than above, so the reader
   * sees it once and the collapsed group reads as the model's own account.
   */
  private title(tools: readonly ToolItem[], completed: boolean): string {
    // One styled terminal line, so whatever markdown the model wrote inside
    // its narration is unwrapped rather than printed as punctuation.
    return stripEmphasis(this.chooseTitle(tools, completed));
  }

  private chooseTitle(tools: readonly ToolItem[], completed: boolean): string {
    const preamble = this.preamble();
    if (preamble) return preamble;
    const headers = this.sequence.items.flatMap((item) =>
      item.type === 'assistant' ? headersOf(item.message) : [],
    );
    const title = completed ? composeTitle(headers) : headers.at(-1);
    if (title) return title;
    const files = this.files(tools);
    return describeTools(tools, commonDirectory(files) ?? files[0], completed);
  }

  /**
   * What the model said on its way into this phase, if it led with anything.
   * Only the leader can carry one — commentary later in a group is a remark
   * about work already done, not a name for it — and only its first sentence
   * is a title, since the rest is available by expanding.
   */
  private preamble(): string | undefined {
    const [leader] = this.sequence.items;
    if (leader?.type !== 'assistant') return undefined;
    const spoken = leader.message.content
      .filter((content) => content.type === 'text')
      .map((content) => content.text.trim())
      .find((text) => text && !isNarration(text));
    if (!spoken) return undefined;
    const [first = ''] = spoken.split('\n');
    return first.trim() || undefined;
  }

  /** A step is a bullet, unless it is the one currently turning. */
  private stepMarker(tool: ToolItem): string {
    if (tool.status === 'running' && this.options.streaming)
      return SPINNER_FRAMES[this.spinnerFrame] ?? STEP_MARKER;
    if (tool.isError) return '✗';
    return tool.status === 'pending' ? '·' : STEP_MARKER;
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

    // The point of a group is not to hide the work but to stop it running off
    // the screen: the last few steps stay legible, one line each, and the rest
    // are accounted for by a count that says how much was folded away.
    const shown = tools.slice(-MAX_STEP_LINES);
    const hidden = tools.length - shown.length;
    if (hidden > 0)
      lines.push(
        truncateToWidth(
          `   ${this.theme.fg('dim', `⋮ ${count(hidden, 'earlier step')}`)}`,
          width,
        ),
      );
    for (const tool of shown) {
      const { action, argument } = toolSubject(tool, this.sequence.cwd);
      const marked = `   ${this.theme.fg(roleColor(tool), this.stepMarker(tool))} ${this.theme.fg(tool.isError ? 'error' : 'muted', action)}`;
      lines.push(
        truncateToWidth(
          argument ? `${marked} ${this.theme.fg('dim', argument)}` : marked,
          width,
        ),
      );
    }

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
