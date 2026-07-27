/**
 * Where one activity group ends and the next begins.
 *
 * Boundaries come from two things: what the tools *do*, and the moments the
 * model stops to address the user. Narration is far too volatile to cut on — a
 * single turn often emits three thinking headers for five tool calls, and they
 * drift every few seconds — but tool activity moves in recognisable phases
 * (explore, then edit, then check), and commentary marks a beat a reader
 * already perceives as a break. Commentary is handled by the shim, which is
 * where messages are visible; everything else is decided here.
 *
 * Measured over the session logs in this repo: grouping per model turn gave a
 * median of 7 groups per user request; these rules give 2 (p90 5), at a median
 * of 12 tool calls each, with 12% of groups holding 1-3 calls.
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
 * Beyond this many calls a group stops being a summary and starts being a
 * black box, so long runs are cut into readable chunks. This is a backstop,
 * not a boundary rule: if groups routinely end here, the rules below are wrong.
 */
export const MAX_GROUP_CALLS = 12;

/**
 * How much pure looking-around a building group absorbs before it is judged to
 * have moved on. A read or two between edits is part of making the change; a
 * run of them is the agent going off to find something else out.
 */
export const MAX_IDLE_CALLS = 4;

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
 * The two things a stretch of agent work can be: finding things out, or
 * changing them.
 *
 * Only changing the code commits a group to `building`; reading, searching and
 * running shell commands are connective tissue that belongs to whatever phase
 * is already open. Checking counts as building because an edit/test/edit/test
 * loop is one activity — making the change work — and splitting on each test
 * run shattered it into a dozen one-call groups.
 */
export type ActivityPhase = 'exploring' | 'building';

function phaseOf(kind: ActivityKind): ActivityPhase | undefined {
  return kind === 'mutate' || kind === 'validate' ? 'building' : undefined;
}

/** Everything about the group currently open that a boundary depends on. */
export interface OpenGroup {
  phase: ActivityPhase;
  /** Tool calls the group already holds. */
  calls: number;
  /** Calls run since the group last changed or checked anything. */
  sinceChange: number;
  /**
   * Whether the group has already been shown to the user as finished. A
   * finished group must never come back to life and start growing again — that
   * is jarring to watch, and it makes the checkmark a lie. Later work opens a
   * new group instead.
   */
  sealed: boolean;
}

/**
 * Should a turn of `calls` calls doing `incoming` start a new group, given the
 * group currently open?
 */
export function startsNewGroup(
  open: OpenGroup | undefined,
  incoming: ActivityKind,
  calls: number,
): boolean {
  if (!open || open.sealed) return true;
  if (open.calls >= MAX_GROUP_CALLS) return true;
  const phase = phaseOf(incoming);
  if (phase !== undefined) return phase !== open.phase;
  return open.phase === 'building' && open.sinceChange + calls > MAX_IDLE_CALLS;
}

/** The open group once a turn of `calls` calls doing `incoming` joins it. */
export function foldTurn(
  open: OpenGroup | undefined,
  incoming: ActivityKind,
  calls: number,
): OpenGroup {
  const phase = phaseOf(incoming);
  return {
    phase: phase ?? open?.phase ?? 'exploring',
    calls: (open?.calls ?? 0) + calls,
    sinceChange: phase ? 0 : (open?.sinceChange ?? 0) + calls,
    sealed: false,
  };
}
