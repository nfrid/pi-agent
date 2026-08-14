import { StringEnum } from '@earendil-works/pi-ai';
import { type Static, Type } from 'typebox';
import type { BackgroundSnapshot, BackgroundStatus } from './manager';

export const WIDGET_KEY = 'background-terminals';
export const RESULT_MESSAGE_TYPE = 'background-terminal-result';
export const DEFAULT_TAIL_LINES = 40;

const startParameters = Type.Object(
  {
    action: StringEnum(['start'] as const, {
      description:
        'Start a non-interactive Bash process and return its background id.',
    }),
    command: Type.String({
      description: 'Shell command to run with /bin/bash -c.',
    }),
    title: Type.String({
      description: 'Short recognizable label for the process.',
    }),
    cwd: Type.Optional(
      Type.String({
        description: 'Working directory; defaults to the current directory.',
      }),
    ),
  },
  { additionalProperties: false },
);

const peekParameters = Type.Object(
  {
    action: StringEnum(['peek'] as const, {
      description:
        'Inspect one process, optionally waiting briefly for it to settle.',
    }),
    id: Type.String({ description: 'Background process id to inspect.' }),
    wait_seconds: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 120,
        description: 'Wait up to this many seconds before inspecting.',
      }),
    ),
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

const listParameters = Type.Object(
  {
    action: StringEnum(['list'] as const, {
      description: 'List the retained background processes and their status.',
    }),
  },
  { additionalProperties: false },
);

const stopParameters = Type.Object(
  {
    action: StringEnum(['stop'] as const, {
      description: 'Stop one or more background processes.',
    }),
    ids: Type.Array(Type.String(), {
      minItems: 1,
      description: 'Background process ids to stop.',
    }),
  },
  { additionalProperties: false },
);

export const Parameters = Type.Union([
  startParameters,
  peekParameters,
  listParameters,
  stopParameters,
]);

export type BackgroundParameters = Static<typeof Parameters>;

export interface ProcessDetails {
  readonly id: string;
  readonly title: string;
  readonly status: BackgroundStatus;
  readonly pid?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

export interface BackgroundToolDetails {
  readonly action: 'start' | 'peek' | 'list' | 'stop';
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
  };
}
