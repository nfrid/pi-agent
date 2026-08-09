/**
 * Where one activity group ends and the next begins.
 *
 * Groups are defined by the assistant's explicit preamble: a non-empty title
 * marked with `titleKind: 'preamble'`. Tool roles, thinking narration, and call
 * counts are intentionally not boundary signals. This makes the pure
 * transcript projection match the units of work the model actually announced,
 * both while a session streams and when it is replayed from disk.
 */

/** The character of a stretch of work, derived from the tools it runs. */
export type ActivityKind =
  | 'inspect'
  | 'mutate'
  | 'validate'
  | 'execute'
  | 'mixed';

/** Just enough of a tool call to classify it. */
export interface ToolDescriptor {
  name: string;
  args: unknown;
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

const TOOL_ACTION_LABEL_MAX = 140;

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

export function activityKind(tools: readonly ToolDescriptor[]): ActivityKind {
  if (tools.length === 0) return 'mixed';
  const names = tools.map((tool) => toolBaseName(tool.name));
  if (names.some((name) => MUTATION_TOOLS.has(name))) return 'mutate';
  if (tools.some(isValidationCommand)) return 'validate';
  if (names.every((name) => INSPECTION_TOOLS.has(name))) return 'inspect';
  if (names.every((name) => name === 'bash')) return 'execute';
  return 'mixed';
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
