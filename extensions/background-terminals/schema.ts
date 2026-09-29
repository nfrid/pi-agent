import { StringEnum } from '@earendil-works/pi-ai';
import { type Static, Type } from 'typebox';
import type { BackgroundSnapshot, BackgroundStatus } from './manager';

export const WIDGET_KEY = 'background-terminals';
export const RESULT_MESSAGE_TYPE = 'background-terminal-result';
export const WATCH_RESULT_MESSAGE_TYPE = 'background-watch-result';
export const DEFAULT_TAIL_LINES = 40;

const Watch = Type.Object(
  {
    contains: Type.String({
      minLength: 1,
      maxLength: 512,
      pattern: '^[^\\r\\n]+$(?![\\s\\S])',
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

export const StartParameters = Type.Object(
  {
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

export const PeekParameters = Type.Object(
  {
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

export const ListParameters = Type.Object({}, { additionalProperties: false });

export const StopParameters = Type.Object(
  {
    ids: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: 'Process ids to terminate.',
    }),
  },
  { additionalProperties: false },
);

export const WatchParameters = Type.Object(
  {
    id: Type.String({ minLength: 1, description: 'Running process id.' }),
    watch: Type.Array(Watch, {
      minItems: 1,
      maxItems: 8,
      description: 'Watches to append; the process is not restarted.',
    }),
  },
  { additionalProperties: false },
);

export const UnwatchParameters = Type.Object(
  {
    id: Type.String({ minLength: 1, description: 'Process id.' }),
    watch_ids: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 8,
      description: 'Watch ids to remove.',
    }),
  },
  { additionalProperties: false },
);

export type StartParams = Static<typeof StartParameters>;
export type PeekParams = Static<typeof PeekParameters>;
export type ListParams = Static<typeof ListParameters>;
export type StopParams = Static<typeof StopParameters>;
export type WatchParams = Static<typeof WatchParameters>;
export type UnwatchParams = Static<typeof UnwatchParameters>;
export type WatchInput = Static<typeof Watch>;
export type BackgroundAction =
  | 'start'
  | 'peek'
  | 'list'
  | 'stop'
  | 'watch'
  | 'unwatch';

const processOutputSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  status: Type.Union(
    ['running', 'done', 'failed', 'killed'].map((status) =>
      Type.Literal(status),
    ),
  ),
  pid: Type.Optional(Type.Number()),
  exitCode: Type.Optional(Type.Number()),
  signal: Type.Optional(Type.String()),
  stdoutBytes: Type.Number(),
  stderrBytes: Type.Number(),
  watches: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        contains: Type.String(),
        status: Type.String(),
        stream: Type.Optional(Type.String()),
        timeoutMs: Type.Optional(Type.Number()),
      }),
    ),
  ),
});
const outputTailSchema = Type.Object({
  text: Type.String(),
  omitted: Type.Boolean(),
  totalBytes: Type.Number(),
  droppedBytes: Type.Number(),
});
export const backgroundOutputSchema = Type.Object({
  action: Type.String(),
  process: Type.Optional(processOutputSchema),
  processes: Type.Optional(Type.Array(processOutputSchema)),
  stdout: Type.Optional(outputTailSchema),
  stderr: Type.Optional(outputTailSchema),
});

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
  readonly action: BackgroundAction;
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
