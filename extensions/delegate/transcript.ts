import type {
  ExtensionCommandContext,
  Theme,
} from '@earendil-works/pi-coding-agent';
import {
  matchesKey,
  type TUI,
  truncateToWidth,
  type Component,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import { explicitTruncate, getDetails, transcriptEntries } from './render-utils';
import type { DelegateDetails, DelegatedRun } from './types';

const MAX_MODAL_CHARS = 64 * 1024;
const MAX_ENTRY_CHARS = 8_000;

function toolResultDetails(entry: unknown): DelegateDetails | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const message = (entry as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return undefined;
  const value = message as {
    role?: unknown;
    toolName?: unknown;
    details?: unknown;
  };
  if (value.role !== 'toolResult' || value.toolName !== 'delegate') return undefined;
  if (!value.details || typeof value.details !== 'object') return undefined;
  return getDetails({ details: value.details as never });
}

/** Find the most recent delegate result in the active session branch. */
export function latestDelegateDetails(
  branch: readonly unknown[],
  selector = '',
): DelegateDetails | undefined {
  const wanted = selector.trim().toLowerCase();
  for (let index = branch.length - 1; index >= 0; index--) {
    const details = toolResultDetails(branch[index]);
    if (!details) continue;
    if (!wanted) return details;
    if (
      details.runs.some(
        (run) =>
          run.name.toLowerCase().includes(wanted) ||
          run.task.toLowerCase().includes(wanted) ||
          run.continuation?.toLowerCase() === wanted,
      )
    )
      return details;
  }
  return undefined;
}

export function transcriptText(runs: readonly DelegatedRun[]): string {
  const blocks = runs.map((run, index) => {
    const entries = transcriptEntries(run);
    const body = entries
      .map((entry) => {
        const text = entry.text?.trim();
        return text
          ? `${entry.label}: ${explicitTruncate(text, MAX_ENTRY_CHARS)}`
          : entry.label;
      })
      .join('\n');
    return `Subagent ${index + 1} · ${run.name} · ${run.state}\n${body || '(no transcript captured)'}`;
  });
  return explicitTruncate(
    blocks.join('\n\n────────────────────────────────────────\n\n'),
    MAX_MODAL_CHARS,
  );
}

function padLine(text: string, width: number): string {
  const bounded = truncateToWidth(text, width, '');
  return `${bounded}${' '.repeat(Math.max(0, width - visibleWidth(bounded)))}`;
}

class TranscriptViewer implements Component {
  private offset = 0;
  private lastWidth = 0;
  private wrapped: string[] = [];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly title: string,
    private readonly content: string,
    private readonly done: () => void,
  ) {}

  handleInput(data: string): void {
    const page = Math.max(1, this.visibleRows());
    let next = this.offset;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.done();
      return;
    }
    if (matchesKey(data, 'up')) next--;
    else if (matchesKey(data, 'down')) next++;
    else if (matchesKey(data, 'pageUp')) next -= page;
    else if (matchesKey(data, 'pageDown')) next += page;
    else if (matchesKey(data, 'home')) next = 0;
    else if (matchesKey(data, 'end')) next = this.maxOffset();
    else return;
    this.offset = Math.max(0, Math.min(this.maxOffset(), next));
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const frameWidth = Math.max(1, width);
    const innerWidth = Math.max(1, frameWidth - 2);
    if (this.lastWidth !== innerWidth) {
      this.lastWidth = innerWidth;
      this.wrapped = this.content
        .split('\n')
        .flatMap((line) => wrapTextWithAnsi(line || ' ', innerWidth));
      this.offset = Math.min(this.offset, this.maxOffset());
    }
    const rows = this.visibleRows();
    const visible = this.wrapped.slice(this.offset, this.offset + rows);
    const top = this.offset > 0 ? '↑ more' : this.title;
    const bottom =
      this.offset < this.maxOffset()
        ? '↓ more · ↑↓/PgUp/PgDn scroll · Esc close'
        : '↑↓/PgUp/PgDn scroll · Esc close';
    const border = (text: string) => this.theme.fg('border', text);
    const row = (text: string) =>
      `${border('│')}${padLine(text, innerWidth)}${border('│')}`;
    return [
      border(`╭${'─'.repeat(innerWidth)}╮`),
      row(this.theme.fg('accent', this.theme.bold(top))),
      ...visible.map((line) => row(line)),
      row(this.theme.fg('dim', bottom)),
      border(`╰${'─'.repeat(innerWidth)}╯`),
    ].map((line) => truncateToWidth(line, frameWidth, ''));
  }

  invalidate(): void {
    this.lastWidth = 0;
  }

  private visibleRows(): number {
    return Math.max(3, Math.min(24, this.tui.terminal.rows - 6));
  }

  private maxOffset(): number {
    return Math.max(0, this.wrapped.length - this.visibleRows());
  }
}

export async function showDelegateTranscript(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const details = latestDelegateDetails(ctx.sessionManager.getBranch(), args);
  if (!details) {
    ctx.ui.notify(
      args.trim()
        ? `No delegate transcript matched "${args.trim()}".`
        : 'No delegate transcript is available in this session.',
      'info',
    );
    return;
  }
  const title =
    details.mode === 'parallel'
      ? `Delegate transcript · ${details.runs.length} subagents`
      : `Delegate transcript · ${details.runs[0]?.name ?? 'Subagent'}`;
  const content = transcriptText(details.runs);
  if (ctx.mode !== 'tui') {
    ctx.ui.notify(`${title}\n\n${content}`, 'info');
    return;
  }
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
    new TranscriptViewer(tui, theme, title, content, () => done()),
  {
    overlay: true,
    overlayOptions: {
      width: '90%',
      minWidth: 40,
      maxHeight: '80%',
      margin: 2,
    },
  });
}

export function registerDelegateTranscriptCommand(
  pi: import('@earendil-works/pi-coding-agent').ExtensionAPI,
): void {
  pi.registerCommand('delegate-transcript', {
    description: 'Inspect the latest delegate transcript in a scrollable modal',
    handler: (args, ctx) => showDelegateTranscript(args, ctx),
  });
}
