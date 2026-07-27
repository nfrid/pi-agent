/**
 * Naming an activity group.
 *
 * Models narrate their own work far better than we could infer it, and they do
 * it constantly: 87% of tool-carrying turns in this repo's session logs contain
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
 * Present participle to past tense. Deriving this morphologically gets
 * "Planned"/"Traced"/"Fixed" wrong in different ways, and the working
 * vocabulary is small and stable, so it is spelled out. Anything unlisted keeps
 * its "-ing" form, which still reads correctly next to a checkmark.
 */
const PAST_TENSE: Readonly<Record<string, string>> = {
  Adding: 'Added',
  Adjusting: 'Adjusted',
  Analyzing: 'Analyzed',
  Analysing: 'Analysed',
  Assessing: 'Assessed',
  Building: 'Built',
  Checking: 'Checked',
  Clarifying: 'Clarified',
  Committing: 'Committed',
  Confirming: 'Confirmed',
  Debugging: 'Debugged',
  Deciding: 'Decided',
  Defining: 'Defined',
  Deploying: 'Deployed',
  Designing: 'Designed',
  Detecting: 'Detected',
  Diagnosing: 'Diagnosed',
  Editing: 'Edited',
  Evaluating: 'Evaluated',
  Examining: 'Examined',
  Fixing: 'Fixed',
  Identifying: 'Identified',
  Implementing: 'Implemented',
  Improving: 'Improved',
  Inspecting: 'Inspected',
  Investigating: 'Investigated',
  Planning: 'Planned',
  Reading: 'Read',
  Refining: 'Refined',
  Removing: 'Removed',
  Replacing: 'Replaced',
  Reviewing: 'Reviewed',
  Running: 'Ran',
  Searching: 'Searched',
  Testing: 'Tested',
  Tracing: 'Traced',
  Updating: 'Updated',
  Validating: 'Validated',
  Verifying: 'Verified',
  Writing: 'Wrote',
};

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
 * Regular "-ing" to "-ed", for the long tail the table cannot enumerate:
 * Inferring → Inferred, Aligning → Aligned, Modifying → Modified, Tracing →
 * Traced. Irregulars stay in the table above, which is consulted first.
 */
function derivePastTense(verb: string): string | undefined {
  if (!/^[A-Za-z]+ing$/.test(verb)) return undefined;
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
  const past = PAST_TENSE[first] ?? derivePastTense(first);
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
