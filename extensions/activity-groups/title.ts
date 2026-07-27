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
 * line tracks what the agent is doing right now. Once it settles the *earliest
 * substantive* header wins: a finished group should say what it was for rather
 * than where it happened to stop, but not attribute the work to the "Planning
 * …" preamble that so often comes first.
 */

import type { AssistantMessage } from '@earendil-works/pi-ai';
import { activityKind, type ToolDescriptor, toolBaseName } from './grouping';

/** Bolded thinking headers, the dominant form. */
const BOLD_HEADER = /^\s*\*{2}(.+?)\*{2}\s*$/;
/** Markdown headings, used by some providers instead. */
const MARKDOWN_HEADER = /^\s*#{1,6}\s+(.+?)\s*$/;

const MAX_TITLE_LENGTH = 90;

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

/**
 * Verbs that announce intent rather than work. A group very often opens with
 * "Planning repository inspection" and only then does the inspecting, and
 * labelling 25 file reads "Planned" describes the wrong thing — so a settled
 * group skips past these to the first header that names actual work.
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

export function isMetaHeader(title: string): boolean {
  const [verb] = title.split(' ');
  return verb !== undefined && META_VERBS.has(verb);
}

function clean(value: string): string | undefined {
  const title = value.trim().replace(/[.…:]+$/, '');
  if (!title || title.length > MAX_TITLE_LENGTH) return undefined;
  return title;
}

/** Every narration header in a message, in the order the model wrote them. */
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

export function toPastTense(title: string): string {
  const [first, ...rest] = title.split(' ');
  const past = first ? PAST_TENSE[first] : undefined;
  return past ? [past, ...rest].join(' ') : title;
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
