import { StringEnum } from '@earendil-works/pi-ai';
import { type Static, Type } from 'typebox';
import type { BackgroundSnapshot, BackgroundStatus } from './manager';

export const WIDGET_KEY = 'background-terminals';
export const RESULT_MESSAGE_TYPE = 'background-terminal-result';
export const WATCH_RESULT_MESSAGE_TYPE = 'background-watch-result';
export const DEFAULT_TAIL_LINES = 40;

const Action = <T extends string>(action: T, description: string) =>
  Type.Literal(action, { description });

const Watch = Type.Object(
  {
    contains: Type.String({
      minLength: 1,
      maxLength: 512,
      pattern: '^[^\\r\\n]+$',
      description: 'Literal, case-sensitive single-line text to match.',
    }),
    stream: Type.Optional(
      StringEnum(['stdout', 'stderr'] as const, {
        description:
          'Limit the match to one output stream; omitted means both.',
      }),
    ),
    timeout_seconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 86400,
        description:
          'Deadline for this one-shot watch; it never kills the job.',
      }),
    ),
  },
  { additionalProperties: false },
);

const StartParameters = Type.Object(
  {
    action: Action('start', 'Launch a new background process.'),
    command: Type.String({
      minLength: 1,
      description: 'Shell command run with /bin/bash -c.',
    }),
    title: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 80,
        description:
          'Optional short label; derived from the command when omitted.',
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description: 'Working directory; defaults to the current directory.',
      }),
    ),
    watch: Type.Optional(
      Type.Array(Watch, {
        maxItems: 8,
        description: 'Optional one-shot future-output watches, at most 8.',
      }),
    ),
  },
  { additionalProperties: false },
);

const PeekParameters = Type.Object(
  {
    action: Action('peek', 'Inspect one process immediately; never waits.'),
    id: Type.String({ minLength: 1, description: 'Process id to inspect.' }),
    tail_lines: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 200,
        description: 'Recent output lines per stream; default 40.',
      }),
    ),
  },
  { additionalProperties: false },
);

const ListParameters = Type.Object(
  {
    action: Action('list', 'List retained processes and watch status.'),
  },
  { additionalProperties: false },
);

const StopParameters = Type.Object(
  {
    action: Action('stop', 'Terminate one or more processes.'),
    ids: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: 'Process ids to terminate.',
    }),
  },
  { additionalProperties: false },
);

const AddWatchParameters = Type.Object(
  {
    action: Action(
      'watch',
      'Add one-shot future-output watches to a running process.',
    ),
    id: Type.String({ minLength: 1, description: 'Running process id.' }),
    watch: Type.Array(Watch, {
      minItems: 1,
      maxItems: 8,
      description: 'Watches to append; the process is not restarted.',
    }),
  },
  { additionalProperties: false },
);

const RemoveWatchParameters = Type.Object(
  {
    action: Action('unwatch', 'Remove watches without stopping the process.'),
    id: Type.String({ minLength: 1, description: 'Process id.' }),
    watch_ids: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 8,
      description: 'Watch ids to remove.',
    }),
  },
  { additionalProperties: false },
);

const ParameterUnion = Type.Union([
  StartParameters,
  PeekParameters,
  ListParameters,
  StopParameters,
  AddWatchParameters,
  RemoveWatchParameters,
]);

// The root is a genuine object schema for Pi validators and UIs. Branches own
// required fields and closed-property validation; the shared index is only the
// one top-level property catalogue and never makes action fields optional.
export const Parameters = Type.Unsafe<Static<typeof ParameterUnion>>({
  type: 'object',
  properties: {
    action: StringEnum(
      ['start', 'peek', 'list', 'stop', 'watch', 'unwatch'] as const,
      {
        description:
          'start launches a process; peek inspects immediately; list shows processes and watches; stop terminates; watch adds future-output watches; unwatch removes them.',
      },
    ),
    command: Type.String({ description: 'Required for start.' }),
    title: Type.String({
      description: 'Optional for start; derived from command when omitted.',
    }),
    cwd: Type.String({ description: 'Optional working directory for start.' }),
    id: Type.String({ description: 'Required for peek, watch, or unwatch.' }),
    ids: Type.Array(Type.String(), { description: 'Required for stop.' }),
    watch: Type.Array(Watch, {
      description: 'Optional for start; required for watch.',
    }),
    watch_ids: Type.Array(Type.String(), {
      description: 'Required for unwatch.',
    }),
    tail_lines: Type.Integer({
      description: 'Optional recent output line count for peek.',
    }),
  },
  required: ['action'],
  additionalProperties: false,
  oneOf: [
    StartParameters,
    PeekParameters,
    ListParameters,
    StopParameters,
    AddWatchParameters,
    RemoveWatchParameters,
  ],
});

export type BackgroundParameters = Static<typeof Parameters>;
export type WatchParameters = Static<typeof Watch>;

export interface ProcessDetails {
  readonly id: string;
  readonly title: string;
  readonly status: BackgroundStatus;
  readonly pid?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly watches?: BackgroundSnapshot['watches'];
}

export interface BackgroundToolDetails {
  readonly action: BackgroundParameters['action'];
  readonly process?: ProcessDetails;
  readonly processes?: ProcessDetails[];
}

export function processDetails(snapshot: BackgroundSnapshot): ProcessDetails {
  return {
    id: snapshot.id,
    title: snapshot.title,
    status: snapshot.status,
    pid: snapshot.pid,
    exitCode: snapshot.exitCode,
    signal: snapshot.signal,
    stdoutBytes: snapshot.stdout.totalBytes,
    stderrBytes: snapshot.stderr.totalBytes,
    ...(snapshot.watches ? { watches: snapshot.watches } : {}),
  };
}
