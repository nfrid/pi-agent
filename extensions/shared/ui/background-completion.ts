import type { ThemeColor } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

export interface CompletionTheme {
  fg(color: ThemeColor, text: string): string;
}

export interface CompletionSegment {
  readonly text: string;
  readonly color: ThemeColor;
}

export interface CompletionRow {
  readonly icon: string;
  readonly color: ThemeColor;
  readonly segments: readonly CompletionSegment[];
}

export interface BackgroundCompletionCard {
  readonly icon: string;
  readonly color: ThemeColor;
  readonly title: readonly CompletionSegment[];
  readonly rows?: readonly CompletionRow[];
}

function renderSegments(
  segments: readonly CompletionSegment[],
  theme: CompletionTheme,
): string {
  return segments.map(({ text, color }) => theme.fg(color, text)).join('');
}

/**
 * Shared transcript card for work that settles outside the initiating turn.
 *
 * The compact view is a single status line. Expanded cards may add indented
 * rows, while agent-only handoff instructions remain in the message content
 * rather than leaking into the user-facing UI.
 */
export function renderBackgroundCompletion(
  card: BackgroundCompletionCard,
  options: { readonly expanded: boolean; readonly outputPad: number },
  theme: CompletionTheme,
): Text {
  const heading = `${theme.fg(card.color, card.icon)} ${renderSegments(card.title, theme)}`;
  const rows = options.expanded
    ? (card.rows ?? []).map(
        (row) =>
          `  ${theme.fg(row.color, row.icon)} ${renderSegments(row.segments, theme)}`,
      )
    : [];
  return new Text([heading, ...rows].join('\n'), options.outputPad, 0);
}
