/**
 * Where one activity group ends and the next begins.
 *
 * Boundaries come from three things: what the tools *do*, the moments the model
 * stops to address the user, and what it announces it is about to do. Tool
 * activity moves in recognisable phases (explore, then edit, then check);
 * commentary marks a beat a reader already perceives as a break; and narration
 * is the model's own account of where one piece of work ended — too eager to
 * cut on by itself, since a single stretch of reading carries three or four
 * headers, but the best boundary available once a group holds real work.
 *
 * `groupTranscript` is the whole of it: a pure function from a transcript to
 * groups, used unchanged for a turn arriving live and for a session replayed
 * from disk. Keeping it pure is what makes grouping reproducible — the same
 * transcript always groups the same way, whether it is being watched or
 * reopened a week later — and it is what the tests measure against real logs.
 *
 * Measured in July 2026 over the 206 session logs in this repo, by a script
 * kept out of the tree since it reads private transcripts. The figures date
 * the rules rather than pin them: grouping per model turn gave
 * a median of 7 groups per user request; these rules give 4.8, at a median of 6
 * calls each (p90 9), with 13% holding three calls or fewer. The cap ends 4% of
 * them, which is what a backstop should be — without the narration rule it
 * ended 63%, because a phase of pure exploration has no other edge to find.
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
const MAX_IDLE_CALLS = 4;

/**
 * How much work a group must already hold before a fresh piece of narration is
 * allowed to end it.
 *
 * Models announce what they are about to do far more often than they change
 * what they are doing — a single stretch of reading can carry three or four
 * headers — so cutting at every one shatters the transcript. But once a group
 * has real work in it, the next announcement is the most honest boundary
 * available: the model itself saying it has moved on. Below this, narration is
 * treated as commentary on work already under way.
 */
const MIN_NARRATED_CALLS = 5;

/**
 * The same, for narration the model wrote where the user could read it.
 *
 * A header in thinking is the model talking to itself and costs it nothing, so
 * it writes them constantly. Announcing a phase to the reader is a deliberate
 * act — this repo's system prompt asks for one at each change of direction —
 * and it means what it says, so it needs far less work behind it to cut.
 *
 * Not none, though: a single call behind an announcement is too small to stand
 * as a group of its own, and models do announce twice in a row. Such a turn
 * joins the next one, and `composeTitle` keeps what both of them said.
 */
const MIN_ANNOUNCED_CALLS = 2;

/** How the model narrated a turn: to itself, to the reader, or not at all. */
export type Narration = 'thought' | 'announced';

function minCallsToCutOn(narration: Narration): number {
  return narration === 'announced' ? MIN_ANNOUNCED_CALLS : MIN_NARRATED_CALLS;
}

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
interface OpenGroup {
  phase: ActivityPhase;
  /** Tool calls the group already holds. */
  calls: number;
  /** Calls run since the group last changed or checked anything. */
  sinceChange: number;
  /** Opened by a header the model wrote to the reader. */
  announced: boolean;
}

/**
 * Should a turn of `calls` calls doing `incoming` start a new group, given the
 * group currently open?
 */
function startsNewGroup(
  open: OpenGroup | undefined,
  incoming: ActivityKind,
  calls: number,
  narration?: Narration,
): boolean {
  if (!open) return true;
  if (open.calls >= MAX_GROUP_CALLS) return true;
  if (narration && open.calls >= minCallsToCutOn(narration)) return true;
  // A group that announced itself keeps what follows until it holds real work.
  // The announcement said what the phase is for, and the first call it makes is
  // as often bookkeeping — a todo update — as the work itself; cutting on the
  // change of character there leaves the announcement alone above the work it
  // named, which is the one thing it must never be.
  if (open.announced && open.calls < MIN_ANNOUNCED_CALLS) return false;
  const phase = phaseOf(incoming);
  if (phase !== undefined) return phase !== open.phase;
  return open.phase === 'building' && open.sinceChange + calls > MAX_IDLE_CALLS;
}

/** The open group once a turn of `calls` calls doing `incoming` joins it. */
function foldTurn(
  open: OpenGroup | undefined,
  incoming: ActivityKind,
  calls: number,
  narration?: Narration,
): OpenGroup {
  const phase = phaseOf(incoming);
  return {
    phase: phase ?? open?.phase ?? 'exploring',
    calls: (open?.calls ?? 0) + calls,
    sinceChange: phase ? 0 : (open?.sinceChange ?? 0) + calls,
    announced: open?.announced ?? narration === 'announced',
  };
}

/**
 * One entry of a transcript, in the order it was appended.
 *
 * This is deliberately the small common shape of a live component and a
 * persisted session message: an assistant message either speaks to the user or
 * only thinks, a tool call has a name and arguments, and anything else is an
 * opaque thing no group may span.
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
      /**
       * Whether the model narrated this turn, and on which channel. The words
       * are the renderer's business; all a boundary needs is that a header was
       * written and who it was written for.
       */
      narration?: Narration;
    }
  | ({ kind: 'tool' } & ToolDescriptor)
  | { kind: 'other' }
);

/** A run of entries that belong together, as indices into the transcript. */
export interface ActivityGroup {
  /** Index of the first entry, which is the group's leader. */
  start: number;
  /** Index of the last entry, inclusive. */
  end: number;
}

/** One model turn: the message that carried the calls, and the calls. */
interface WorkTurn {
  kind: 'turn';
  start: number;
  end: number;
  tools: ToolDescriptor[];
  /** Index of the first call, which the calls follow contiguously. */
  firstCall?: number;
  /** How this turn narrated itself, if it did. */
  narration?: Narration;
  /** Opened by commentary: a declared turning point. See `turnsOf`. */
  led: boolean;
}

/** A point no group may span. Carries no entries of its own. */
interface Break {
  kind: 'break';
}

type Turn = WorkTurn | Break;

function turnsOf(entries: readonly TranscriptEntry[]): Turn[] {
  const turns: Turn[] = [];
  let open: WorkTurn | undefined;

  const close = () => {
    if (open) turns.push(open);
    open = undefined;
  };
  const breakHere = () => {
    close();
    turns.push({ kind: 'break' });
  };
  const openAt = (index: number, rest: Partial<WorkTurn> = {}): WorkTurn => ({
    kind: 'turn',
    start: index,
    end: index,
    tools: [],
    led: false,
    ...rest,
  });

  const take = (entry: TranscriptEntry, index: number): void => {
    if (entry.kind === 'assistant') {
      close();
      // Commentary is the model addressing the user, and a reader already
      // perceives it as a break, so groups agree with it. It belongs to the
      // work *below* it: a model says "now I'll check how sessions expire"
      // and then goes and does that, which makes the line the natural name
      // for what follows rather than a footnote to what came before.
      //
      // A message that has not spoken yet still opens a turn, before its tool
      // calls arrive: an empty message is one still streaming in, not a
      // boundary, and treating it as one made groups flicker shut and reopen
      // as the model typed.
      open = openAt(index, { narration: entry.narration, led: entry.speaks });
      return;
    }
    if (entry.kind === 'tool') {
      // Tools with no preceding assistant message still form a turn.
      open ??= openAt(index);
      open.end = index;
      open.firstCall ??= index;
      open.tools.push(entry);
      return;
    }
    breakHere();
  };

  for (const [index, entry] of entries.entries()) {
    take(entry, index);
    if (entry.closesGroup) breakHere();
  }
  close();
  return turns;
}

/**
 * The entries one chunk of a turn covers, where `placed` calls of it are
 * already down and this chunk takes `take` more.
 *
 * The first chunk starts at the turn's leader — the message itself, so the
 * narration belongs to the group it named — and every later one starts at the
 * call it begins with. The last chunk runs to the turn's end, which sweeps up
 * anything trailing the calls.
 */
function chunkRange(
  turn: WorkTurn,
  placed: number,
  take: number,
): { start: number; end: number } {
  const firstCall = turn.firstCall ?? turn.start;
  const done = placed + take >= turn.tools.length;
  return {
    start: placed === 0 ? turn.start : firstCall + placed,
    end: done ? turn.end : firstCall + placed + take - 1,
  };
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
  let state: OpenGroup | undefined;

  const flush = () => {
    if (open) groups.push(open);
    open = undefined;
    state = undefined;
  };

  for (const turn of turnsOf(entries)) {
    if (turn.kind === 'break') {
      flush();
      continue;
    }
    // Commentary always ends the phase before it. Whether it also opens one
    // depends on what the model did next: followed by work it leads and names
    // that work, and followed by nothing it is just a message, left ungrouped
    // for Pi to render as it always has.
    if (turn.led) {
      flush();
      if (turn.tools.length === 0) continue;
    }
    // A turn whose tools have not arrived yet cannot set the phase, so it
    // continues the open group rather than guessing at a new one.
    const kind: ActivityKind =
      turn.tools.length > 0 ? activityKind(turn.tools) : 'inspect';

    // The turn is placed a chunk at a time, because a single message can carry
    // more calls than a group may hold: models fire ten or twenty at once, and
    // a cap that only applied between messages let those through as one
    // unreadable block. A turn's calls are contiguous and run to its end.
    let placed = 0;
    do {
      const remaining = turn.tools.length - placed;
      // Only the head of the turn carries its narration; a chunk split off by
      // the cap is the same announced piece of work continuing.
      const narration = placed === 0 ? turn.narration : undefined;
      if (startsNewGroup(state, kind, remaining, narration)) flush();
      // Whatever room the group has left, which a flush has just reset to all
      // of it — so a chunk is never empty and the loop always advances.
      const take = Math.min(remaining, MAX_GROUP_CALLS - (state?.calls ?? 0));
      const { start, end } = chunkRange(turn, placed, take);
      open ??= { start, end };
      open.end = end;
      state = foldTurn(state, kind, take, narration);
      placed += take;
    } while (placed < turn.tools.length);
  }
  flush();
  return groups;
}
