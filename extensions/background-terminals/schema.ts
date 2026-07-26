import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import type { BackgroundSnapshot, BackgroundStatus } from './manager';

export const WIDGET_KEY = 'background-terminals';
export const RESULT_MESSAGE_TYPE = 'background-terminal-result';
export const DEFAULT_TAIL_LINES = 40;

export const Parameters = Type.Object({
  action: StringEnum(['start', 'peek', 'list', 'stop'] as const, {
    description: 'Operation to perform',
  }),
  command: Type.Optional(
    Type.String({ description: 'Shell command for start' }),
  ),
  title: Type.Optional(
    Type.String({ description: 'Short recognizable label for start' }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: 'Working directory for start; defaults to cwd',
    }),
  ),
  id: Type.Optional(Type.String({ description: 'Process id for peek' })),
  ids: Type.Optional(
    Type.Array(Type.String(), { description: 'Process ids for stop' }),
  ),
  wait_seconds: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 120,
      description:
        'For peek, wait up to this long for settlement before inspecting',
    }),
  ),
  tail_lines: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 200,
      description: 'Output lines per stream returned by peek; default 40',
    }),
  ),
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
