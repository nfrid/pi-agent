import path from 'node:path';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { stringArg, toolBaseName, toolPath } from './grouping';
import { describeTools, headersOf, isMetaHeader, toPastTense } from './title';
import type {
  SequenceItem,
  SequenceOptions,
  SequenceRenderer,
  SequenceSnapshot,
} from './types';

type ToolItem = Extract<SequenceItem, { type: 'tool' }>;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;
const MAX_COMMAND_WIDTH = 60;

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
      ? `${name === 'bash' ? 'Running' : 'Checking'} ${command.split('\n')[0]?.slice(0, MAX_COMMAND_WIDTH)}`
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
   * the work as it moves. Settled groups take the first header that names real
   * work, skipping the "Planning …" preamble a phase so often opens with.
   */
  private title(tools: readonly ToolItem[], completed: boolean): string {
    const headers = this.sequence.items.flatMap((item) =>
      item.type === 'assistant' ? headersOf(item.message) : [],
    );
    const header = completed
      ? (headers.find((candidate) => !isMetaHeader(candidate)) ?? headers[0])
      : headers.at(-1);
    if (header) return completed ? toPastTense(header) : header;
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
