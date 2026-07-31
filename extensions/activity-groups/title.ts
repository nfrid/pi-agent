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
import { IRREGULAR_PAST_TENSE, META_VERBS, RUSSIAN_PAST_TENSE } from './verbs';

/** Bolded thinking headers, the dominant form. */
const BOLD_HEADER = /^\s*\*{2}(.+?)\*{2}\s*$/;
/** Markdown headings, used by some providers instead. */
const MARKDOWN_HEADER = /^\s*#{1,6}\s+(.+?)\s*$/;

const MAX_TITLE_LENGTH = 90;

/** A verb a title can be built on: "Inspecting", "Fixing". */
const PARTICIPLE = /^[A-Za-z]+ing$/;

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
 * Regular "-ing" to "-ed", which is nearly all of them: Inferring → Inferred,
 * Aligning → Aligned, Modifying → Modified, Tracing → Traced, Planning →
 * Planned. Strong verbs stay in the table in `verbs.ts`, consulted first.
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

function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function isRussianVerb(word: string): boolean {
  return capitalized(word) in RUSSIAN_PAST_TENSE;
}

function isMetaVerb(word: string): boolean {
  return META_VERBS.has(capitalized(word));
}

/** Past tense of one recognised narration verb, in the case it was written in. */
function pastOf(word: string): string | undefined {
  const normalized = capitalized(word);
  const past =
    RUSSIAN_PAST_TENSE[normalized] ??
    IRREGULAR_PAST_TENSE[normalized] ??
    derivePastTense(normalized);
  if (!past) return undefined;
  return word.charAt(0) === normalized.charAt(0)
    ? past
    : past.charAt(0).toLowerCase() + past.slice(1);
}

export function toPastTense(title: string): string {
  const words = title.split(' ');
  const past = words[0] ? pastOf(words[0]) : undefined;
  if (!past) return title;
  return words
    .map((word, index) => {
      if (index === 0) return past;
      // A header often names two things — "Verifying the scratch edit and
      // cleaning up" — and conjugating only the first reads as a mistake.
      const conjunction = words[index - 1]?.toLowerCase();
      if (conjunction !== 'and' && conjunction !== 'и') return word;
      return pastOf(word) ?? word;
    })
    .join(' ');
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
      // Only a recognised narration form is a verb worth conjugating. Headers
      // do not always start with one — "1. Fresh context retrieval" is a
      // sentence — and reading its first word as a verb produced titles like
      // "Planned and 1. fresh context retrieval".
      return pastOf(word)
        ? { verb: word, rest: rest.join(' ') }
        : { verb: '', rest: header };
    });
  const narrated = parsed.filter((entry) => entry.verb);
  const first = narrated[0];
  // Nothing to conjugate: the model's own words are still the best label.
  if (!first) return parsed[0]?.rest;

  // Do not splice two languages into one phrase when a model switches midway
  // through a group. The opening narration determines the title's language.
  const russian = isRussianVerb(first.verb);
  const sameLanguage = narrated.filter(
    ({ verb }) => isRussianVerb(verb) === russian,
  );
  const counts = new Map<string, number>();
  for (const { verb } of sameLanguage)
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  // What the group spent itself on — never "Planning", even if it said so most.
  let dominant = first.verb;
  for (const { verb } of sameLanguage) {
    if (isMetaVerb(verb)) continue;
    if (
      isMetaVerb(dominant) ||
      (counts.get(verb) ?? 0) > (counts.get(dominant) ?? 0)
    )
      dominant = verb;
  }

  // The goal is stated by the opening header; later ones name sub-steps.
  const subject =
    first.rest || sameLanguage.find((entry) => entry.rest)?.rest || '';
  const opened = toPastTense(first.verb);
  const other =
    dominant === first.verb
      ? undefined
      : sameLanguage.find((entry) => entry.verb === dominant);
  if (!other) return subject ? `${opened} ${subject}` : opened;

  // Two distinct things the group did, each with what it was done to. Sharing
  // one subject between them — "Planned and created temporary activity" for a
  // group that planned the activity and created the notes — credits the second
  // verb with the first one's work and loses what the group produced.
  //
  // Only when the second verb was said once, though: a verb repeated across
  // headers is one push broken into steps, and their subjects are step labels
  // ("Implementing T1", "Implementing T2") that name nothing on their own.
  const conjunction = russian ? 'и' : 'and';
  const spelt = `${opened} ${first.rest} ${conjunction} ${toPastTense(dominant).toLowerCase()} ${other.rest}`;
  if (
    counts.get(dominant) === 1 &&
    first.rest &&
    other.rest &&
    spelt.length <= MAX_TITLE_LENGTH
  )
    return spelt;
  const phrase = `${opened} ${conjunction} ${toPastTense(dominant).toLowerCase()}`;
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
