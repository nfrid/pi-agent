/**
 * Where one activity group ends and the next begins.
 *
 * Boundaries are decided by what the tools *do*, never by what the model says
 * about it. Narration is far too volatile to cut on: a single model turn often
 * emits three thinking headers for five tool calls, and the headers drift every
 * few seconds. Tool activity, by contrast, moves in recognisable phases —
 * explore, then edit, then check — and those are the beats worth showing.
 *
 * Measured over the session logs in this repo, grouping per model turn gave a
 * median of 7 groups per user request; this rule gives 2, at a median of 6 tool
 * calls each.
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
 * black box, so long runs are cut into readable chunks.
 */
export const MAX_GROUP_CALLS = 25;

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

/**
 * Should the turn described by `incoming` start a new group, given the group
 * currently open? `calls` is how many tool calls that group already holds.
 */
export function startsNewGroup(
  open: { phase: ActivityPhase; calls: number } | undefined,
  incoming: ActivityKind,
): boolean {
  if (!open) return true;
  if (open.calls >= MAX_GROUP_CALLS) return true;
  const phase = phaseOf(incoming);
  return phase !== undefined && phase !== open.phase;
}

/** The phase a group is in once `incoming` has been folded into it. */
export function phaseAfter(
  open: ActivityPhase | undefined,
  incoming: ActivityKind,
): ActivityPhase {
  return phaseOf(incoming) ?? open ?? 'exploring';
}
