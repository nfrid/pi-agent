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
 * A group has two titles. While it is live the *latest* header wins, so the
 * line tracks what the agent is doing right now. Once it settles, the whole
 * group's narration is composed into one phrase — see `composeTitle` — because
 * no single header describes a phase that planned something and then built it.
 */

import type { AssistantMessage } from '@earendil-works/pi-ai';
import { activityKind, type ToolDescriptor, toolBaseName } from './grouping';

/** Bolded thinking headers, the dominant form. */
const BOLD_HEADER = /^\s*\*{2}(.+?)\*{2}\s*$/;
/** Markdown headings, used by some providers instead. */
const MARKDOWN_HEADER = /^\s*#{1,6}\s+(.+?)\s*$/;

const MAX_TITLE_LENGTH = 90;

/** A verb a title can be built on: "Inspecting", "Fixing". */
const PARTICIPLE = /^[A-Za-z]+ing$/;

/**
 * Present participle to past tense, for the verbs `derivePastTense` cannot
 * reach. Strong verbs only: every row here is one the "-ed" rule gets wrong,
 * "Built" for "Builded" and "Ran" for "Runned". Regular verbs are derived, so
 * adding one here is dead weight — `title.test.ts` asserts the table stays
 * irregular.
 *
 * The set is closed: English stopped minting strong verbs centuries ago. What
 * is listed is the part of it a coding agent plausibly opens a narration header
 * with. Anything absent keeps its "-ing" form, which still reads correctly next
 * to a checkmark.
 */
export const IRREGULAR_PAST_TENSE: Readonly<Record<string, string>> = {
  Beginning: 'Began',
  Binding: 'Bound',
  Breaking: 'Broke',
  Bringing: 'Brought',
  Building: 'Built',
  Casting: 'Cast',
  Catching: 'Caught',
  Choosing: 'Chose',
  Cutting: 'Cut',
  Dealing: 'Dealt',
  Digging: 'Dug',
  Drawing: 'Drew',
  Feeding: 'Fed',
  Finding: 'Found',
  Getting: 'Got',
  Giving: 'Gave',
  Hiding: 'Hid',
  Hitting: 'Hit',
  Holding: 'Held',
  Keeping: 'Kept',
  Leading: 'Led',
  Leaving: 'Left',
  Letting: 'Let',
  Losing: 'Lost',
  Making: 'Made',
  Meaning: 'Meant',
  Overwriting: 'Overwrote',
  Putting: 'Put',
  Reading: 'Read',
  Rebuilding: 'Rebuilt',
  Rereading: 'Reread',
  Rerunning: 'Reran',
  Resetting: 'Reset',
  Rewriting: 'Rewrote',
  Running: 'Ran',
  Seeing: 'Saw',
  Sending: 'Sent',
  Setting: 'Set',
  Shutting: 'Shut',
  Spending: 'Spent',
  Spinning: 'Spun',
  Splitting: 'Split',
  Spreading: 'Spread',
  Sticking: 'Stuck',
  Taking: 'Took',
  Thinking: 'Thought',
  Throwing: 'Threw',
  Undoing: 'Undid',
  Understanding: 'Understood',
  Writing: 'Wrote',
};

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

/** Every narration header in a message, in the order the model wrote them. */
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

export function headersOf(message: AssistantMessage): string[] {
  const headers: string[] = [];
  for (const content of message.content) {
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
 * Regular "-ing" to "-ed", which is nearly all of them: Inferring → Inferred,
 * Aligning → Aligned, Modifying → Modified, Tracing → Traced, Planning →
 * Planned. Strong verbs stay in the table above, which is consulted first.
 */
export function derivePastTense(verb: string): string | undefined {
  if (!PARTICIPLE.test(verb)) return undefined;
  const stem = verb.slice(0, -3);
  if (stem.length < 2) return undefined;
  // The consonant doubling that "-ing" introduced is kept, because the past
  // tense doubles it too: Inferring → Inferr → Inferred, not Infered.
  if (/[^aeiou]y$/i.test(stem)) return `${stem.slice(0, -1)}ied`;
  return `${stem}ed`;
}

/**
 * Verbs that announce intent rather than work. A group may well open with one —
 * "Planning the thing" — and saying so is honest, but planning is never what a
 * group should be *named* for when it also went and did something.
 */
const META_VERBS = new Set([
  'Planning',
  'Preparing',
  'Considering',
  'Deciding',
  'Determining',
  'Clarifying',
  'Thinking',
  'Weighing',
]);

export function toPastTense(title: string): string {
  const [first, ...rest] = title.split(' ');
  if (!first) return title;
  const past = IRREGULAR_PAST_TENSE[first] ?? derivePastTense(first);
  return past ? [past, ...rest].join(' ') : title;
}

/**
 * Title a finished group from all of its narration at once.
 *
 * No single header describes a phase that planned something and then built it:
 * the first header undersells it ("Planned the thing" for work that shipped),
 * the last one is wherever the model happened to stop ("Implemented T4" when
 * T1-T4 were the job). So the verb comes from what the group actually did —
 * how it opened and what it spent most of its time on — and the subject from
 * the header that named the goal, giving "Planned and implemented the thing".
 */
export function composeTitle(headers: readonly string[]): string | undefined {
  const parsed = headers
    .filter((header) => header.trim())
    .map((header) => {
      const [word = '', ...rest] = header.split(' ');
      // Only a participle is a verb worth conjugating. Headers do not always
      // start with one — "1. Fresh context retrieval" is a heading, not a
      // sentence — and reading its first word as a verb produced titles like
      // "Planned and 1. fresh context retrieval".
      return PARTICIPLE.test(word)
        ? { verb: word, rest: rest.join(' ') }
        : { verb: '', rest: header };
    });
  const narrated = parsed.filter((entry) => entry.verb);
  const first = narrated[0];
  // Nothing to conjugate: the model's own words are still the best label.
  if (!first) return parsed[0]?.rest;

  const counts = new Map<string, number>();
  for (const { verb } of narrated)
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  // What the group spent itself on — never "Planning", even if it said so most.
  let dominant = first.verb;
  for (const { verb } of narrated) {
    if (META_VERBS.has(verb)) continue;
    if (
      META_VERBS.has(dominant) ||
      (counts.get(verb) ?? 0) > (counts.get(dominant) ?? 0)
    )
      dominant = verb;
  }

  // The goal is stated by the opening header; later ones name sub-steps.
  const subject =
    first.rest || narrated.find((entry) => entry.rest)?.rest || '';
  const verbs =
    dominant === first.verb
      ? [toPastTense(first.verb)]
      : [toPastTense(first.verb), toPastTense(dominant).toLowerCase()];
  const phrase = verbs.join(' and ');
  return subject ? `${phrase} ${subject}` : phrase;
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
