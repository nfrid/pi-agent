/**
 * Where one activity group ends and the next begins.
 *
 * Groups are defined by the assistant's explicit preamble: a non-empty title
 * marked with `titleKind: 'preamble'`. Tool roles, thinking narration, and call
 * counts are intentionally not boundary signals. This makes the pure
 * transcript projection match the units of work the model actually announced,
 * both while a session streams and when it is replayed from disk.
 */

/** One observable phase in a stretch of work, derived from a tool call. */
export type ActivityPhase =
  | 'inspect'
  | 'mutate'
  | 'validate'
  | 'execute'
  | 'coordinate'
  | 'other';

/** Just enough of a tool call to classify it. */
export interface ToolDescriptor {
  name: string;
  args: unknown;
  status?: string;
  isError?: boolean;
  result?: unknown;
  data?: unknown;
}

const INSPECTION_TOOLS = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'glob',
  'web_search',
  'fetch_content',
  'get_search_content',
  'inspect_shell',
]);

const MUTATION_TOOLS = new Set([
  'edit',
  'write',
  'multi_edit',
  'apply_patch',
  'str_replace',
]);

const VALIDATION_COMMAND =
  /(^|[\s;&|])(npm (test|run)|pnpm (test|run)|yarn (test|run)|bun (test|run)|vitest|jest|pytest|cargo (test|check|clippy)|go test|tsc|biome|eslint|ruff|mypy)(\s|$)/;

const COORDINATION_TOOLS = new Set([
  'background',
  'delegate',
  'delegates',
  'delegate_changes',
  'delegate_jobs',
  'tasks',
  'todo',
]);

/**
 * Historical compatibility value. Grouping deliberately never consults it:
 * preambles, not call counts, define boundaries.
 */
export const MAX_GROUP_CALLS = 12;

/** How the model narrated a turn: to itself, to the reader, or not at all. */
export type Narration = 'thought' | 'announced';

/** What a tool call does, for describing a group in plain words. */
export type ToolRole = 'edit' | 'read' | 'search' | 'command' | 'other';

export function toolRole(name: string): ToolRole {
  const base = toolBaseName(name);
  if (MUTATION_TOOLS.has(base)) return 'edit';
  if (base === 'grep' || base === 'find' || base === 'glob') return 'search';
  if (base === 'bash' || base === 'inspect_shell') return 'command';
  if (INSPECTION_TOOLS.has(base)) return 'read';
  return 'other';
}

export function toolBaseName(name: string): string {
  return name.split('.').at(-1) ?? name;
}

export function stringArg(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== 'object' || !(key in args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function toolPath(args: unknown): string | undefined {
  return stringArg(args, 'path') ?? stringArg(args, 'file_path');
}

export const TOOL_ACTION_LABEL_MAX = 140;

export type ActivityLineChanges = {
  added: number;
  changed: number;
  removed: number;
};

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r\n|\r|\n/u);
  if (/\r\n|\r|\n$/u.test(text)) lines.pop();
  return lines;
}

function replacementLineChanges(
  oldText: string,
  newText: string,
): ActivityLineChanges {
  const before = textLines(oldText);
  const after = textLines(newText);
  let start = 0;
  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (
    start <= beforeEnd &&
    start <= afterEnd &&
    before[start] === after[start]
  )
    start += 1;
  while (
    beforeEnd >= start &&
    afterEnd >= start &&
    before[beforeEnd] === after[afterEnd]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const removedLines = Math.max(0, beforeEnd - start + 1);
  const addedLines = Math.max(0, afterEnd - start + 1);
  const changed = Math.min(removedLines, addedLines);
  return {
    added: addedLines - changed,
    changed,
    removed: removedLines - changed,
  };
}

/** Derive line changes only from complete, well-known edit/write arguments. */
export function activityToolLineChanges(
  tool: Pick<ToolDescriptor, 'name' | 'args'>,
): ActivityLineChanges | undefined {
  const name = toolBaseName(tool.name);
  const args = recordValue(tool.args);
  if (name === 'write' && typeof args?.content === 'string')
    return { added: textLines(args.content).length, changed: 0, removed: 0 };
  if (name !== 'edit' || !Array.isArray(args?.edits) || args.edits.length === 0)
    return undefined;
  const total: ActivityLineChanges = { added: 0, changed: 0, removed: 0 };
  let counted = false;
  for (const value of args.edits) {
    const edit = recordValue(value);
    if (typeof edit?.oldText !== 'string' || typeof edit.newText !== 'string')
      continue;
    const changes = replacementLineChanges(edit.oldText, edit.newText);
    total.added += changes.added;
    total.changed += changes.changed;
    total.removed += changes.removed;
    counted = true;
  }
  return counted ? total : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Return a command duration only when a tool result/data explicitly records it. */
export function activityToolDurationMs(
  tool: ToolDescriptor,
): number | undefined {
  const name = toolBaseName(tool.name);
  if (
    name !== 'bash' &&
    name !== 'shell' &&
    name !== 'exec' &&
    name !== 'inspect_shell'
  )
    return undefined;
  return (
    finiteNumber(recordValue(tool.data)?.durationMs) ??
    finiteNumber(recordValue(tool.result)?.durationMs)
  );
}

export interface ActivityGroupFacts {
  lineChanges: ActivityLineChanges;
  commandDurationMs: number;
}

export function activityGroupFacts(
  tools: readonly ToolDescriptor[],
): ActivityGroupFacts {
  const lineChanges: ActivityLineChanges = { added: 0, changed: 0, removed: 0 };
  let commandDurationMs = 0;
  for (const tool of tools) {
    const changes = activityToolLineChanges(tool);
    if (changes) {
      lineChanges.added += changes.added;
      lineChanges.changed += changes.changed;
      lineChanges.removed += changes.removed;
    }
    commandDurationMs += activityToolDurationMs(tool) ?? 0;
  }
  return { lineChanges, commandDurationMs };
}

function actionArgs(args: unknown): Record<string, unknown> | undefined {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : undefined;
}

function compactAction(value: string, max = TOOL_ACTION_LABEL_MAX): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function actionValue(args: unknown, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringArg(args, key);
    if (value) return compactAction(value, 120);
  }
  return undefined;
}

/**
 * A bounded, tool-aware label for compact activity rows.
 *
 * Tool names alone make a collapsed run look like a list of indistinguishable
 * dots. Keep the verb/name visible, then add the one argument that tells a
 * reader what happened. Opaque or unusually shaped provider arguments still
 * fall back to the stable tool name rather than being guessed at.
 */
export function toolActionSummary(tool: ToolDescriptor): string {
  const base = toolBaseName(tool.name);
  const args = actionArgs(tool.args);
  const path = toolPath(tool.args);
  if (base === 'bash' || base === 'shell' || base === 'exec') {
    const description = stringArg(tool.args, 'description');
    if (description) return compactAction(description);
    const command = actionValue(tool.args, 'command', 'cmd', 'script');
    return command ? `${base} ${command}` : base;
  }
  if (base === 'delegate' || base === 'delegates') {
    const action = actionValue(tool.args, 'action', 'operation');
    const name = actionValue(
      tool.args,
      'name',
      'task',
      'description',
      'prompt',
    );
    if (action && name) return `${base} ${action}: ${name}`;
    if (name) return `${base}: ${name}`;
    if (args && Array.isArray(args.tasks))
      return `${base}: ${args.tasks.length} task${args.tasks.length === 1 ? '' : 's'}`;
    return action ? `${base} ${action}` : base;
  }
  if (base === 'todo' || base === 'tasks') {
    const action = actionValue(tool.args, 'action', 'operation');
    const id = actionValue(tool.args, 'id', 'taskId');
    if (action && id) return `${base} ${action} ${id}`;
    if (action) return `${base} ${action}`;
    if (id) return `${base} ${id}`;
    return base;
  }
  if (
    base === 'web_search' ||
    base === 'web' ||
    base === 'search_web' ||
    base === 'fetch_content' ||
    base === 'get_search_content'
  ) {
    const query = actionValue(tool.args, 'query', 'q', 'url', 'href');
    return query ? `${base}: ${query}` : base;
  }
  if (path) return `${base} ${compactAction(path, 120)}`;
  const value = actionValue(tool.args, 'pattern', 'query', 'url', 'text');
  return value ? `${base}: ${value}` : base;
}

function isValidationCommand(tool: ToolDescriptor): boolean {
  if (toolBaseName(tool.name) !== 'bash') return false;
  const command = stringArg(tool.args, 'command')?.toLowerCase() ?? '';
  return VALIDATION_COMMAND.test(command);
}

export function activityToolPhase(tool: ToolDescriptor): ActivityPhase {
  const name = toolBaseName(tool.name);
  if (MUTATION_TOOLS.has(name)) return 'mutate';
  if (isValidationCommand(tool)) return 'validate';
  if (INSPECTION_TOOLS.has(name)) return 'inspect';
  if (COORDINATION_TOOLS.has(name)) return 'coordinate';
  if (name === 'bash' || name === 'shell' || name === 'exec') return 'execute';
  return 'other';
}

/** Preserve phase order while folding only adjacent calls with the same role. */
export function activityPhases(
  tools: readonly ToolDescriptor[],
): readonly ActivityPhase[] {
  const phases: ActivityPhase[] = [];
  for (const tool of tools) {
    const phase = activityToolPhase(tool);
    if (phases.at(-1) !== phase) phases.push(phase);
  }
  return phases;
}

/**
 * One entry of a transcript, in the order it was appended.
 *
 * This is deliberately the small common shape of a live component and a
 * persisted session message: an assistant message either speaks to the user or
 * only thinks, a tool call has a name and arguments, and anything else is an
 * opaque thing no group may span unless it explicitly opts into transparency.
 */
export type TranscriptEntry = {
  /**
   * Nothing after this entry may join its group. This is how a caller reports
   * something only it can know — chiefly that the run ended here, so the group
   * the user watched finish is finished for good.
   */
  closesGroup?: boolean;
} & (
  | {
      kind: 'assistant';
      speaks: boolean;
      /** The assistant is still streaming this turn; projections keep it live. */
      streaming?: boolean;
      /**
       * Whether the model narrated this turn, and on which channel. The words
       * are the renderer's business; all a boundary needs is that a header was
       * written and who it was written for.
       */
      narration?: Narration;
      /** Latest pure title supplied by a transcript adapter, if known. */
      title?: string;
      /** A preamble names the work below and outranks later narration. */
      titleKind?: 'preamble' | 'narration';
    }
  | ({ kind: 'tool' } & ToolDescriptor & {
        status?: 'pending' | 'running' | 'complete' | 'success' | 'error';
        isError?: boolean;
      })
  | {
      kind: 'other';
      /**
       * This semantic event is rendered as part of the active activity rather
       * than as an opaque transcript boundary. It never opens a group alone.
       */
      continuesGroup?: boolean;
    }
);

/** A run of entries that belong together, as indices into the transcript. */
export interface ActivityGroup {
  /** Index of the first entry, which is the group's leader. */
  start: number;
  /** Index of the last entry, inclusive. */
  end: number;
}

/** The canonical boundary around an entry at a page edge. */
export interface ActivityGroupBoundary {
  /** Index of the owning assistant preamble, when one is present. */
  start: number;
  /** Index of the group's last entry. */
  end: number;
}

export interface LeadingContinuationSpan {
  /** First entry in the partial activity segment. */
  start: number;
  /** Last entry hidden before its owner or a hard boundary arrives. */
  end: number;
}

function startsActivityBoundary(entry: TranscriptEntry): boolean {
  if (entry.kind === 'assistant')
    return entry.speaks || entry.titleKind === 'preamble';
  return entry.kind === 'other' && entry.continuesGroup !== true;
}

/**
 * Return the partial activity prefix described by a paginated history head.
 *
 * A page can begin in the middle of a group, where the owning preamble is on
 * the preceding page. Do not infer this from consecutive tools: thinking
 * messages and semantic continuation events (todo/custom/compaction) are part
 * of the same hidden span too. The first ordinary assistant/boundary entry is
 * the owner of the next visible segment; at origin there is no partial prefix.
 */
export function leadingContinuationSpan(
  entries: readonly TranscriptEntry[],
  leadingContinuation = false,
): LeadingContinuationSpan | undefined {
  const first = entries[0];
  if (!leadingContinuation || !first || startsActivityBoundary(first))
    return undefined;
  for (let index = 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry && startsActivityBoundary(entry))
      return { start: 0, end: index - 1 };
  }
  return { start: 0, end: entries.length - 1 };
}

/** Compatibility spelling for consumers that call this a leading activity span. */
export const leadingActivityContinuationSpan = leadingContinuationSpan;

/**
 * Find the group owning an entry. This is intentionally derived from
 * `groupTranscript`, rather than a pagination-specific heuristic.
 */
export function owningActivityGroupBoundary(
  entries: readonly TranscriptEntry[],
  index: number,
): ActivityGroupBoundary | undefined {
  return groupTranscript(entries).find(
    (group) => group.start <= index && group.end >= index,
  );
}

/**
 * Break a transcript into activity groups.
 *
 * Pure and prefix-stable: every boundary is decided from the entries before it,
 * so appending entries can only extend the last group or open new ones. That is
 * what makes the same function usable for a live turn and for a session
 * replayed from disk, and what stops a finished group from rearranging itself
 * under the reader.
 *
 * Entries covered by no returned group — plain commentary, anything Pi renders
 * that is neither a message nor a call — are shown as Pi renders them.
 */
export function groupTranscript(
  entries: readonly TranscriptEntry[],
): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let open: ActivityGroup | undefined;
  let openHasTool = false;
  let openIsStreaming = false;

  const flush = (): void => {
    // A settled preamble without a call is only a transcript lead, not an
    // activity card. A streaming lead remains eligible so the UI can show its
    // preparing state before the first tool component arrives.
    if (open && (openHasTool || openIsStreaming)) groups.push(open);
    open = undefined;
    openHasTool = false;
    openIsStreaming = false;
  };

  for (const [index, entry] of entries.entries()) {
    if (
      entry.kind === 'assistant' &&
      entry.titleKind === 'preamble' &&
      entry.title?.trim()
    ) {
      // A later preamble is the only ordinary way to start the next group.
      flush();
      open = { start: index, end: index };
      openIsStreaming = entry.streaming === true;
    } else if (entry.kind === 'tool') {
      // Unannounced tool runs remain outside the activity model. Once a
      // preamble has opened a group, all tools belong to it regardless of
      // classification or count.
      if (open) {
        open.end = index;
        openHasTool = true;
      }
    } else if (entry.kind === 'assistant') {
      if (entry.speaks) flush();
      // Thinking-only assistant entries neither open nor split groups. Keep
      // them in an already-open range so a preparing turn remains groupable.
      else if (open) {
        open.end = index;
        openIsStreaming ||= entry.streaming === true;
      }
    } else if (entry.continuesGroup && open) {
      // Semantic events such as todo snapshots are transcript-visible but do
      // not represent a new activity boundary. An event without an active
      // group is intentionally ignored here rather than opening one.
      open.end = index;
    } else {
      flush();
    }

    if (entry.closesGroup) flush();
  }

  flush();
  return groups;
}
