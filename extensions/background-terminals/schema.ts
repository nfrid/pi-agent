import { StringEnum } from '@earendil-works/pi-ai';
import { type Static, Type } from 'typebox';
import type { BackgroundSnapshot, BackgroundStatus } from './manager';

export const WIDGET_KEY = 'background-terminals';
export const RESULT_MESSAGE_TYPE = 'background-terminal-result';
export const DEFAULT_TAIL_LINES = 40;

export const Parameters = Type.Object(
  {
    action: StringEnum(['start', 'peek', 'list', 'stop'] as const, {
      description:
        'start launches a process and returns its id; peek inspects one process and can wait briefly; list shows retained processes and status; stop terminates one or more processes.',
    }),
    command: Type.Optional(
      Type.String({
        description: 'Required for start: shell command run with /bin/bash -c.',
      }),
    ),
    title: Type.Optional(
      Type.String({
        description: 'Required for start: short recognizable process label.',
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          'For start: working directory; defaults to the current directory.',
      }),
    ),
    id: Type.Optional(
      Type.String({ description: 'Required for peek: process id to inspect.' }),
    ),
    ids: Type.Optional(
      Type.Array(Type.String(), {
        minItems: 1,
        description: 'Required for stop: process ids to terminate.',
      }),
    ),
    wait_seconds: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 120,
        description:
          'For peek: wait up to this many seconds before inspecting.',
      }),
    ),
    tail_lines: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 200,
        description: 'For peek: recent output lines per stream; default 40.',
      }),
    ),
  },
  { additionalProperties: false },
);

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
