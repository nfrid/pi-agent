import path from 'node:path';
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import {
  stringArg,
  toolBaseName,
  toolPath,
  toolRole,
} from '../../packages/activity-model/src/grouping';
import {
  describeTools,
  headersOf,
  isNarration,
  type NarrationChannel,
  stripEmphasis,
} from '../../packages/activity-model/src/title';
import { hasUnresolvedToolFailure } from './outcome';
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
  if (name === 'delegate') {
    const action = stringArg(tool.args, 'action');
    const agentName = stringArg(tool.args, 'name');
    const args =
      tool.args && typeof tool.args === 'object' && !Array.isArray(tool.args)
        ? (tool.args as Record<string, unknown>)
        : undefined;
    const taskCount = Array.isArray(args?.tasks) ? args.tasks.length : 0;
    return {
      action: action ? `Delegate ${action}` : 'Delegating',
      argument:
        agentName ??
        (taskCount > 0
          ? `${taskCount} subagent${taskCount === 1 ? '' : 's'}`
          : undefined),
    };
  }
  if (name === 'todo' || name === 'tasks') {
    const action = stringArg(tool.args, 'action');
    const id = stringArg(tool.args, 'id');
    const args =
      tool.args && typeof tool.args === 'object' && !Array.isArray(tool.args)
        ? (tool.args as Record<string, unknown>)
        : undefined;
    const operationCount = Array.isArray(args?.operations)
      ? args.operations.length
      : 0;
    return {
      action: action ? `Tasks ${action}` : 'Updating tasks',
      argument:
        id ??
        (operationCount > 0
          ? `${operationCount} operation${operationCount === 1 ? '' : 's'}`
          : undefined),
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
   * Groups use the model's latest narration header, both live and settled, so
   * the label stays in the model's original words. A preamble outranks headers:
   * when the model announced this phase to the reader — "Checking how sessions
   * expire" — that line *is* the group, and it is printed here rather than
   * above, so the reader sees it once and the collapsed group reads as the
   * model's own account.
   */
  private title(tools: readonly ToolItem[], completed: boolean): string {
    // One styled terminal line, so whatever markdown the model wrote inside
    // its narration is unwrapped rather than printed as punctuation.
    return stripEmphasis(
      this.narratedTitle() ?? this.toolTitle(tools, completed),
    );
  }

  /**
   * The model's own words for this phase, if it gave any, taking what it said
   * to the reader over what it only thought.
   *
   * A turn commonly carries both: the model thinks "**Creating a workspace**"
   * on its way in and then announces "**Exercising planning, file work and
   * cleanup**". Composing the two led with the passing thought — "Created a
   * workspace" for a group that went on to do far more — so a channel the
   * reader was addressed on wins outright, and thinking is what titles a group
   * that never spoke.
   */
  private narratedTitle(): string | undefined {
    const preamble = this.preamble();
    // Keep the model's original wording after the group settles. A label may
    // be a participle, a sentence, or another language; inventing a completed
    // form would risk changing what the phase actually says.
    if (preamble) return preamble;
    const spoken = this.headers('text');
    const headers = spoken.length > 0 ? spoken : this.headers('thinking');
    return headers.at(-1);
  }

  private headers(channel: NarrationChannel): string[] {
    return this.sequence.items.flatMap((item) =>
      item.type === 'assistant' ? headersOf(item.message, channel) : [],
    );
  }

  /** The fallback for a group that narrated nothing: what its tools did. */
  private toolTitle(tools: readonly ToolItem[], completed: boolean): string {
    const files = this.files(tools);
    return describeTools(tools, commonDirectory(files) ?? files[0], completed);
  }

  /**
   * What the model said on its way into this phase, if it led with anything.
   *
   * Only what came before the group's first call can be one: a message that
   * speaks after the work has started is a remark about work already done, not
   * a name for it. Everything ahead of that call is the model announcing what
   * it is off to do, whether it announced it in the message that opened the
   * group or in a bare line before it. Only the first sentence is a title,
   * since the rest is available by expanding.
   */
  private preamble(): string | undefined {
    for (const item of this.sequence.items) {
      if (item.type === 'tool') break;
      if (item.type !== 'assistant') continue;
      const spoken = item.message.content
        .filter((content) => content.type === 'text')
        .map((content) => content.text.trim())
        .find((text) => text && !isNarration(text));
      if (!spoken) continue;
      const [first = ''] = spoken.split('\n');
      // A title is a label, not a sentence, so it does not end in a stop.
      const title = first.trim().replace(/[.…:]+$/, '');
      if (title) return title;
    }
    return undefined;
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

  /** The group's own lines: how it went, and what it was. */
  private headlineLines(
    tools: readonly ToolItem[],
    completed: boolean,
    failed: boolean,
    width: number,
  ): string[] {
    const marker = completed
      ? failed
        ? '✗'
        : '✓'
      : SPINNER_FRAMES[this.spinnerFrame];
    const color = failed ? 'error' : completed ? 'success' : 'accent';
    const showPrefix = width > 3;
    const prefix = showPrefix ? ` ${this.theme.fg(color, marker)} ` : '';
    const indent = showPrefix ? '   ' : '';
    // Before the first call arrives this is only the model's changing thought,
    // not an activity-group title yet. Keep white text reserved for titles of
    // established groups so the transient state is visually unambiguous.
    const titleColor = !completed && tools.length === 0 ? 'muted' : 'text';
    const titleLines = wrapTextWithAnsi(
      this.theme.fg(titleColor, this.title(tools, completed)),
      Math.max(1, width - indent.length),
    );
    return titleLines.map((line, index) =>
      truncateToWidth(`${index === 0 ? prefix : indent}${line}`, width),
    );
  }

  /**
   * One line per call, most recent last.
   *
   * The point of a group is not to hide the work but to stop it running off the
   * screen: the last few steps stay legible and the rest are accounted for by a
   * count that says how much was folded away.
   */
  private stepLines(tools: readonly ToolItem[]): string[] {
    const shown = tools.slice(-MAX_STEP_LINES);
    const hidden = tools.length - shown.length;
    const lines =
      hidden > 0
        ? [`   ${this.theme.fg('dim', `⋮ ${count(hidden, 'earlier step')}`)}`]
        : [];
    for (const tool of shown) {
      const { action, argument } = toolSubject(tool, this.sequence.cwd);
      const marked = `   ${this.theme.fg(roleColor(tool), this.stepMarker(tool))} ${this.theme.fg(tool.isError ? 'error' : 'muted', action)}`;
      lines.push(
        argument ? `${marked} ${this.theme.fg('dim', argument)}` : marked,
      );
    }
    return lines;
  }

  /** The tally under the group: how much, where, how long, what broke. */
  private metadataLines(
    tools: readonly ToolItem[],
    completed: boolean,
    failed: boolean,
    width: number,
  ): string[] {
    const files = this.files(tools);
    const directory = commonDirectory(files);
    // A group opens the moment the model commits to tool calls, so it can be
    // briefly empty while the first call is still streaming in.
    const parts = tools.length > 0 ? [count(tools.length, 'call')] : [];
    if (files.length > 0)
      parts.push(
        directory
          ? `${count(files.length, 'file')} in ${directory}`
          : count(files.length, 'file'),
      );
    if (completed && this.sequence.completedAt !== undefined)
      parts.push(
        formatDuration(this.sequence.completedAt - this.sequence.startedAt),
      );
    const historicalFailed = tools.filter((tool) => tool.isError).length;
    if (historicalFailed > 0)
      parts.push(
        `${historicalFailed} failed attempt${historicalFailed === 1 ? '' : 's'}`,
      );
    if (parts.length === 0) return [];
    const indent = width > 3 ? '   ' : '';
    return wrapTextWithAnsi(
      this.theme.fg(failed ? 'error' : 'muted', parts.join(' · ')),
      Math.max(1, width - indent.length),
    ).map((line) => truncateToWidth(`${indent}${line}`, width));
  }

  render(width: number): string[] {
    const tools = this.sequence.items.filter(
      (item): item is ToolItem => item.type === 'tool',
    );
    const completed = !this.options.streaming;
    const failed = hasUnresolvedToolFailure(tools);
    const metadata = this.metadataLines(tools, completed, failed, width);

    const lines = [
      '',
      ...this.headlineLines(tools, completed, failed, width),
      ...this.stepLines(tools),
      ...metadata,
    ].map((line) => truncateToWidth(line, width));

    // The default view is Pi's own rendering and wraps itself.
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
