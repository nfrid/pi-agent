import path from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';
import type {
  SequenceItem,
  SequenceOptions,
  SequenceRenderer,
  SequenceSnapshot,
} from './types';

type ActivityKind = 'inspect' | 'modify' | 'validate' | 'execute' | 'work';
type ToolItem = Extract<SequenceItem, { type: 'tool' }>;

const INSPECTION_TOOLS = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'web_search',
  'fetch_content',
  'get_search_content',
]);
const MUTATION_TOOLS = new Set(['edit', 'write']);
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

const STATUS_VERBS: Readonly<Record<string, string>> = {
  Inspecting: 'Inspected',
  Reading: 'Read',
  Searching: 'Searched',
  Tracing: 'Traced',
  Checking: 'Checked',
  Reviewing: 'Reviewed',
  Updating: 'Updated',
  Editing: 'Edited',
  Writing: 'Wrote',
  Running: 'Ran',
  Testing: 'Tested',
  Validating: 'Validated',
  Building: 'Built',
  Implementing: 'Implemented',
  Fixing: 'Fixed',
  Debugging: 'Debugged',
  Deploying: 'Deployed',
  Committing: 'Committed',
};

function toolBaseName(name: string): string {
  return name.split('.').at(-1) ?? name;
}

function stringArg(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== 'object' || !(key in args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toolPath(args: unknown): string | undefined {
  return stringArg(args, 'path') ?? stringArg(args, 'file_path');
}

function displayPath(value: string, cwd: string): string {
  const relative = path
    .relative(cwd, path.resolve(cwd, value))
    .replace(/\\/g, '/');
  return relative && !relative.startsWith('../')
    ? relative
    : value.replace(/\\/g, '/');
}

function activityKind(tools: readonly ToolItem[]): ActivityKind {
  const names = tools.map((tool) => toolBaseName(tool.name));
  if (names.some((name) => MUTATION_TOOLS.has(name))) return 'modify';
  if (
    tools.some((tool) => {
      if (toolBaseName(tool.name) !== 'bash') return false;
      const command = stringArg(tool.args, 'command')?.toLowerCase() ?? '';
      return /(^|\s)(test|vitest|jest|pytest|cargo test|go test|npm test|npm run (test|check|lint|typecheck)|pnpm test)(\s|$)/.test(
        command,
      );
    })
  )
    return 'validate';
  if (names.length > 0 && names.every((name) => INSPECTION_TOOLS.has(name)))
    return 'inspect';
  if (names.length > 0 && names.every((name) => name === 'bash'))
    return 'execute';
  return 'work';
}

function statusTitle(message: AssistantMessage): string | undefined {
  for (const content of [...message.content].reverse()) {
    const value =
      content.type === 'thinking'
        ? content.thinking
        : content.type === 'text'
          ? content.text
          : undefined;
    if (!value) continue;
    const lines = value
      .split('\n')
      .map((candidate) => candidate.trim().replace(/^#+\s*/, ''));
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line || line.length > 100) continue;
      const verb = Object.keys(STATUS_VERBS).find((candidate) =>
        line.startsWith(`${candidate} `),
      );
      if (verb) return line.replace(/[.…]+$/, '');
    }
  }
  return undefined;
}

function completedStatusTitle(title: string): string {
  const verb = Object.keys(STATUS_VERBS).find((candidate) =>
    title.startsWith(`${candidate} `),
  );
  return verb ? `${STATUS_VERBS[verb]}${title.slice(verb.length)}` : title;
}

function fallbackTitle(kind: ActivityKind, completed: boolean): string {
  const titles: Record<ActivityKind, [string, string]> = {
    inspect: ['Inspecting files', 'Inspected files'],
    modify: ['Updating files', 'Updated files'],
    validate: ['Running validation', 'Ran validation'],
    execute: ['Running commands', 'Ran commands'],
    work: ['Working', 'Completed tool activity'],
  };
  return titles[kind][completed ? 1 : 0];
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(1, Math.round(milliseconds))}ms`;
  if (milliseconds < 10_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return `${Math.round(milliseconds / 1000)}s`;
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
    const intent = [...this.sequence.items]
      .reverse()
      .find(
        (item): item is Extract<SequenceItem, { type: 'assistant' }> =>
          item.type === 'assistant' && !item.provisional,
      )?.message;
    const liveTitle = intent ? statusTitle(intent) : undefined;
    const title = liveTitle
      ? completed
        ? completedStatusTitle(liveTitle)
        : liveTitle
      : fallbackTitle(activityKind(tools), completed);

    const lines = [
      '',
      truncateToWidth(
        ` ${this.theme.fg(color, marker)} ${this.theme.fg('text', title)}`,
        width,
      ),
    ];
    if (!completed) {
      const lastTool = tools.at(-1);
      if (lastTool) {
        const rawPath = toolPath(lastTool.args);
        const subject = rawPath
          ? ` ${displayPath(rawPath, this.sequence.cwd)}`
          : '';
        const name = toolBaseName(lastTool.name);
        const action = INSPECTION_TOOLS.has(name)
          ? 'Reading'
          : MUTATION_TOOLS.has(name)
            ? 'Updating'
            : name === 'bash'
              ? 'Running command'
              : `Running ${name}`;
        lines.push(
          truncateToWidth(
            `   ${this.theme.fg('muted', `${action}${subject}`)}`,
            width,
          ),
        );
      }
    }

    const files = new Set(
      tools
        .map((tool) => toolPath(tool.args))
        .filter((value): value is string => value !== undefined),
    );
    const metadata = [
      `${tools.length} ${tools.length === 1 ? 'call' : 'calls'}`,
    ];
    if (files.size > 0)
      metadata.push(`${files.size} ${files.size === 1 ? 'file' : 'files'}`);
    if (completed && this.sequence.completedAt !== undefined) {
      metadata.push(
        formatDuration(this.sequence.completedAt - this.sequence.startedAt),
      );
    }
    const failedCount = tools.filter((tool) => tool.isError).length;
    if (failedCount > 0) metadata.push(`${failedCount} failed`);
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
