/**
 * Naming an activity group.
 *
 * Models narrate their own work far better than we could infer it, and they do
 * it constantly: as of July 2026, 87% of tool-carrying turns in this repo's
 * session logs contain
 * a bolded thinking header — "**Inspecting tool manager startup and tests**",
 * "**Identifying race condition in session shutdown**". Those headers are the
 * label. We only fall back to describing the tools when there is no narration.
 *
 * A group's title is the model's own wording. While it is live and once it
 * settles, the latest header wins; an announced preamble takes precedence over
 * thinking headers. We do not conjugate or compose model narration: preserving
 * the original wording keeps the label specific and avoids invented grammar.
 */

import type { AssistantMessage } from '@earendil-works/pi-ai';
import { activityKind, type ToolDescriptor, toolBaseName } from './grouping';

/** Bolded thinking headers, the dominant form. */
const BOLD_HEADER = /^\s*\*{2}(.+?)\*{2}\s*$/;
/** Markdown headings, used by some providers instead. */
const MARKDOWN_HEADER = /^\s*#{1,6}\s+(.+?)\s*$/;

const MAX_TITLE_LENGTH = 90;

/**
 * Drop inline markdown from a line that is about to be printed as a title.
 *
 * A title is one styled line of terminal output, not rendered markdown, so
 * emphasis the model wrote inside its narration arrives as literal asterisks:
 * "Now I'll check **how sessions expire**". Only paired bold and code spans
 * are unwrapped — single `*` and `_` are left alone, since `*.ts` and
 * `__init__.py` are far more common in this position than italics.
 */
export function stripEmphasis(value: string): string {
  return value.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
}

function clean(value: string): string | undefined {
  const title = value.trim().replace(/[.…:]+$/, '');
  if (!title || title.length > MAX_TITLE_LENGTH) return undefined;
  return title;
}

/**
 * Is this text block narration rather than something said to the user?
 *
 * Which channel a header arrives on is the model's business, not ours. Some
 * put it in thinking; others — Codex-family models in particular — write the
 * same line as ordinary text, so a message whose entire text is
 * "**Creating a throwaway fixture**" is labelling the calls that follow, not
 * addressing anyone. Reading that as speech ended a group on almost every
 * turn, which is what shattered those sessions into single-call groups.
 *
 * A header mixed with prose is not this: that message really is talking.
 */
export function isNarration(text: string): boolean {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.length > 0 &&
    lines.every((line) => BOLD_HEADER.test(line) || MARKDOWN_HEADER.test(line))
  );
}

/**
 * Which channel a header was written on. They are not equal: a header in
 * thinking is the model talking to itself on the way in, while the same line
 * written as text was addressed to the reader. See `headersOf`.
 */
export type NarrationChannel = 'text' | 'thinking';

/**
 * Every narration header in a message, in the order the model wrote them,
 * optionally from one channel only.
 */
export function headersOf(
  message: AssistantMessage,
  channel?: NarrationChannel,
): string[] {
  const headers: string[] = [];
  for (const content of message.content) {
    if (channel && content.type !== channel) continue;
    const value =
      content.type === 'thinking'
        ? content.thinking
        : content.type === 'text'
          ? content.text
          : undefined;
    if (!value) continue;
    for (const line of value.split('\n')) {
      const match = BOLD_HEADER.exec(line) ?? MARKDOWN_HEADER.exec(line);
      if (!match?.[1]) continue;
      const title = clean(match[1]);
      if (title) headers.push(title);
    }
  }
  return headers;
}

/**
 * Describe the group by its tools, for the minority of turns that arrive with
 * no narration at all. Concrete beats generic: name the thing being worked on
 * where one subject dominates.
 */
export function describeTools(
  tools: readonly ToolDescriptor[],
  subject: string | undefined,
  completed: boolean,
): string {
  const kind = activityKind(tools);
  const verbs: Record<typeof kind, [string, string]> = {
    inspect: ['Exploring', 'Explored'],
    mutate: ['Editing', 'Edited'],
    validate: ['Checking', 'Checked'],
    execute: ['Running commands', 'Ran commands'],
    mixed: ['Working', 'Worked'],
  };
  const verb = verbs[kind][completed ? 1 : 0];
  if (subject) return `${verb} ${subject}`;
  if (kind === 'execute' || kind === 'mixed') return verb;
  const names = [...new Set(tools.map((tool) => toolBaseName(tool.name)))];
  return names.length === 1 && names[0]
    ? `${verb} with ${names[0]}`
    : `${verb} the codebase`;
}
