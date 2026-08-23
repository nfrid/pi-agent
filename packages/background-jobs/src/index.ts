import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import path from 'node:path';

export const BACKGROUND_JOBS_PROTOCOL_VERSION = 1;
export const BACKGROUND_JOBS_MAX_LINE_BYTES = 1024 * 1024;
export const BACKGROUND_JOBS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const BACKGROUND_JOBS_LIST_OWNER_BYTES = 256;
export const BACKGROUND_JOBS_LIST_TITLE_BYTES = 256;
export const BACKGROUND_JOBS_LIST_COMMAND_BYTES = 1_000;
export const BACKGROUND_JOBS_LIST_CWD_BYTES = 1_024;
export const BACKGROUND_JOBS_LIST_ERROR_BYTES = 1_024;
export const BACKGROUND_JOBS_MAX_COMMAND_BYTES = 256 * 1024;
export const BACKGROUND_JOBS_MAX_TITLE_BYTES = 8 * 1024;
export const BACKGROUND_JOBS_MAX_CWD_BYTES = 16 * 1024;
export const BACKGROUND_JOBS_MAX_OWNER_BYTES = 4 * 1024;
export const BACKGROUND_JOBS_MAX_OUTPUT_BYTES = 256 * 1024;
export const BACKGROUND_JOBS_STDERR_OUTPUT_BYTES = 128 * 1024;
export const BACKGROUND_JOBS_MAX_WAIT_MS = 120_000;
export const BACKGROUND_JOBS_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const BACKGROUND_JOBS_MAX_ENV_COUNT = 64;
export const BACKGROUND_JOBS_MAX_ENV_KEY_BYTES = 128;
export const BACKGROUND_JOBS_MAX_ENV_VALUE_BYTES = 16 * 1024;
export const BACKGROUND_JOBS_MAX_ENV_BYTES = 64 * 1024;
export const BACKGROUND_JOBS_MAX_ARGV_COUNT = 128;
export const BACKGROUND_JOBS_MAX_EXECUTABLE_BYTES = 4 * 1024;
export const BACKGROUND_JOBS_MAX_ARG_BYTES = 64 * 1024;
export const BACKGROUND_JOBS_MAX_ARGV_BYTES = 256 * 1024;
export const BACKGROUND_JOBS_MAX_EVENT_LINE_BYTES = 64 * 1024;
export const BACKGROUND_JOBS_MAX_EVENT_BYTES = 4 * 1024 * 1024;
export const BACKGROUND_JOBS_MAX_EVENT_RESPONSE_BYTES = 256 * 1024;
export const BACKGROUND_JOBS_MAX_EVENT_RECORD_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export type BackgroundJobStatus = 'running' | 'done' | 'failed' | 'killed';

export interface OutputSnapshot {
  readonly text: string;
  readonly totalBytes: number;
  readonly droppedBytes: number;
}

/** Bounded UTF-8 tail shared by the host and consumers. */
export class OutputTail {
  private chunks: string[] = [];
  private retainedBytes = 0;
  private cachedText = '';
  private dirty = false;
  totalBytes = 0;
  droppedBytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: string): void {
    if (!chunk) return;
    const originalBytes = Buffer.byteLength(chunk);
    this.totalBytes += originalBytes;
    if (originalBytes > this.maxBytes) {
      this.droppedBytes += this.retainedBytes;
      this.chunks = [];
      this.retainedBytes = 0;
      const bytes = Buffer.from(chunk);
      let start = bytes.length - this.maxBytes;
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      this.droppedBytes += start;
      chunk = bytes.subarray(start).toString('utf8');
    }
    const chunkBytes = Buffer.byteLength(chunk);
    const lastIndex = this.chunks.length - 1;
    const last = this.chunks[lastIndex];
    const lastBytes = last === undefined ? 0 : Buffer.byteLength(last);
    if (
      last !== undefined &&
      lastBytes < 4096 &&
      lastBytes + chunkBytes <= this.maxBytes
    )
      this.chunks[lastIndex] = last + chunk;
    else this.chunks.push(chunk);
    this.retainedBytes += chunkBytes;
    while (this.retainedBytes > this.maxBytes) {
      const first = this.chunks[0];
      if (first === undefined) break;
      const bytes = Buffer.from(first);
      const excess = this.retainedBytes - this.maxBytes;
      if (bytes.length <= excess && this.chunks.length > 1) {
        this.chunks.shift();
        this.retainedBytes -= bytes.length;
        this.droppedBytes += bytes.length;
        continue;
      }
      let start = Math.min(excess, bytes.length);
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      this.chunks[0] = bytes.subarray(start).toString('utf8');
      this.retainedBytes -= start;
      this.droppedBytes += start;
    }
    this.dirty = true;
  }

  snapshot(): OutputSnapshot {
    if (this.dirty) {
      this.cachedText = this.chunks.join('');
      this.dirty = false;
    }
    return {
      text: this.cachedText,
      totalBytes: this.totalBytes,
      droppedBytes: this.droppedBytes,
    };
  }
}

export type BackgroundJobEventStream = 'stdout' | 'stderr';

export interface BackgroundJobEvent {
  readonly offset: number;
  readonly stream: BackgroundJobEventStream;
  readonly text: string;
  /** The retained line text was clipped at the per-line bound. */
  readonly truncated: boolean;
}

export interface BackgroundJobEventsSnapshot {
  readonly events: BackgroundJobEvent[];
  /** True when records before the requested offset were pruned. */
  readonly truncated: boolean;
  /** True when the response reached the end of a settled job's event file. */
  readonly complete: boolean;
  readonly nextOffset: number;
}

export interface BackgroundJobSnapshot {
  readonly id: string;
  readonly ownerSession: string;
  readonly title: string;
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly events?: boolean;
  readonly pid?: number;
  readonly status: BackgroundJobStatus;
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly error?: string;
  readonly timedOut?: boolean;
  /** Host-persisted notification acknowledgement used across manager recreation. */
  readonly completionDelivered?: boolean;
  readonly stdout: OutputSnapshot;
  readonly stderr: OutputSnapshot;
}

export function backgroundJobsLaunchFingerprint(
  input: Pick<
    StartBackgroundJobInput,
    'command' | 'title' | 'cwd' | 'argv' | 'env' | 'timeoutMs' | 'events'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        command: input.command,
        title: input.title,
        cwd: input.cwd,
        argv: input.argv ?? null,
        env:
          input.env === undefined
            ? null
            : Object.fromEntries(
                Object.keys(input.env)
                  .sort()
                  .map((key) => [key, input.env?.[key]]),
              ),
        timeoutMs: input.timeoutMs ?? null,
        events: input.events === true,
      }),
    )
    .digest('hex');
}

export interface StartBackgroundJobInput {
  readonly id: string;
  readonly ownerSession: string;
  /** A bounded display string; argv is never copied into this field. */
  readonly command: string;
  readonly title: string;
  readonly cwd: string;
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly events?: boolean;
}

type BackgroundJobsRequest =
  | { v: 1; op: 'start'; input: StartBackgroundJobInput }
  | { v: 1; op: 'list'; ownerSession: string }
  | { v: 1; op: 'inspect'; ownerSession: string; id: string }
  | { v: 1; op: 'wait'; ownerSession: string; id: string; waitMs: number }
  | { v: 1; op: 'stop'; ownerSession: string; ids: string[] }
  | { v: 1; op: 'ack'; ownerSession: string; id: string }
  | { v: 1; op: 'events'; ownerSession: string; id: string; offset: number };

export type BackgroundJobsRequestPayload =
  | { op: 'start'; input: StartBackgroundJobInput }
  | { op: 'list'; ownerSession: string }
  | { op: 'inspect'; ownerSession: string; id: string }
  | { op: 'wait'; ownerSession: string; id: string; waitMs: number }
  | { op: 'stop'; ownerSession: string; ids: string[] }
  | { op: 'ack'; ownerSession: string; id: string }
  | { op: 'events'; ownerSession: string; id: string; offset: number };

export type BackgroundJobsResponse = {
  v: 1;
  ok: boolean;
  error?: string;
  code?: string;
  job?: BackgroundJobSnapshot;
  jobs?: BackgroundJobSnapshot[];
  events?: BackgroundJobEventsSnapshot;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function text(value: unknown, name: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > maxBytes
  )
    throw new Error(`Invalid or oversized ${name}.`);
  return value;
}
function uuid(value: unknown): string {
  const id = text(value, 'job id', 128);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      id,
    )
  )
    throw new Error('Job id must be a UUID.');
  return id;
}
function owner(value: unknown): string {
  return text(value, 'owner session', BACKGROUND_JOBS_MAX_OWNER_BYTES);
}

export function parseBackgroundJobsEnv(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new Error('Invalid environment.');
  const entries = Object.entries(value);
  if (entries.length > BACKGROUND_JOBS_MAX_ENV_COUNT)
    throw new Error('Environment has too many entries.');
  const result: Record<string, string> = {};
  let totalBytes = 0;
  for (const [key, rawValue] of entries.sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
      Buffer.byteLength(key) > BACKGROUND_JOBS_MAX_ENV_KEY_BYTES
    )
      throw new Error('Invalid environment key.');
    if (typeof rawValue !== 'string' || rawValue.includes('\0'))
      throw new Error('Invalid environment value.');
    const valueBytes = Buffer.byteLength(rawValue);
    if (valueBytes > BACKGROUND_JOBS_MAX_ENV_VALUE_BYTES)
      throw new Error('Oversized environment value.');
    totalBytes += Buffer.byteLength(key) + valueBytes + 2;
    if (totalBytes > BACKGROUND_JOBS_MAX_ENV_BYTES)
      throw new Error('Environment exceeded its byte bound.');
    result[key] = rawValue;
  }
  return result;
}

function parseTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > BACKGROUND_JOBS_MAX_TIMEOUT_MS
  )
    throw new Error('Invalid timeout duration.');
  return value;
}

function parseArgv(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1)
    throw new Error('Invalid argv.');
  if (value.length > BACKGROUND_JOBS_MAX_ARGV_COUNT)
    throw new Error('Argv has too many arguments.');
  const result: string[] = [];
  let totalBytes = 0;
  for (const [index, item] of value.entries()) {
    const maxBytes =
      index === 0
        ? BACKGROUND_JOBS_MAX_EXECUTABLE_BYTES
        : BACKGROUND_JOBS_MAX_ARG_BYTES;
    if (
      typeof item !== 'string' ||
      !item ||
      item.includes('\0') ||
      Buffer.byteLength(item) > maxBytes
    )
      throw new Error(
        index === 0
          ? 'Invalid or oversized executable.'
          : 'Invalid or oversized argv argument.',
      );
    totalBytes += Buffer.byteLength(item) + 1;
    if (totalBytes > BACKGROUND_JOBS_MAX_ARGV_BYTES)
      throw new Error('Argv exceeded its byte bound.');
    result.push(item);
  }
  return result;
}

function parseEvents(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean')
    throw new Error('Invalid event capture option.');
  return value;
}

export function parseBackgroundJobsRequest(
  value: unknown,
): BackgroundJobsRequest {
  if (
    !record(value) ||
    value.v !== BACKGROUND_JOBS_PROTOCOL_VERSION ||
    typeof value.op !== 'string'
  )
    throw new Error('Invalid background-jobs request.');
  switch (value.op) {
    case 'start': {
      if (!record(value.input)) throw new Error('Invalid start input.');
      const argv = parseArgv(value.input.argv);
      const env = parseBackgroundJobsEnv(value.input.env);
      const timeoutMs = parseTimeout(value.input.timeoutMs);
      const events = parseEvents(value.input.events);
      return {
        v: 1,
        op: 'start',
        input: {
          id: uuid(value.input.id),
          ownerSession: owner(value.input.ownerSession),
          command: text(
            value.input.command,
            'command',
            BACKGROUND_JOBS_MAX_COMMAND_BYTES,
          ),
          title: text(
            value.input.title,
            'title',
            BACKGROUND_JOBS_MAX_TITLE_BYTES,
          ),
          cwd: text(value.input.cwd, 'cwd', BACKGROUND_JOBS_MAX_CWD_BYTES),
          ...(argv === undefined ? {} : { argv }),
          ...(env === undefined ? {} : { env }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(events === undefined ? {} : { events }),
        },
      };
    }
    case 'list':
      return { v: 1, op: 'list', ownerSession: owner(value.ownerSession) };
    case 'inspect':
    case 'wait': {
      if (value.op === 'wait') {
        if (
          typeof value.waitMs !== 'number' ||
          !Number.isInteger(value.waitMs) ||
          value.waitMs < 0 ||
          value.waitMs > BACKGROUND_JOBS_MAX_WAIT_MS
        )
          throw new Error('Invalid wait duration.');
        return {
          v: 1,
          op: 'wait',
          ownerSession: owner(value.ownerSession),
          id: uuid(value.id),
          waitMs: value.waitMs,
        };
      }
      return {
        v: 1,
        op: 'inspect',
        ownerSession: owner(value.ownerSession),
        id: uuid(value.id),
      };
    }
    case 'stop': {
      if (
        !Array.isArray(value.ids) ||
        value.ids.length < 1 ||
        value.ids.length > 32
      )
        throw new Error('Invalid stop ids.');
      return {
        v: 1,
        op: 'stop',
        ownerSession: owner(value.ownerSession),
        ids: value.ids.map(uuid),
      };
    }
    case 'ack':
      return {
        v: 1,
        op: 'ack',
        ownerSession: owner(value.ownerSession),
        id: uuid(value.id),
      };
    case 'events':
      if (
        typeof value.offset !== 'number' ||
        !Number.isSafeInteger(value.offset) ||
        value.offset < 0
      )
        throw new Error('Invalid event offset.');
      return {
        v: 1,
        op: 'events',
        ownerSession: owner(value.ownerSession),
        id: uuid(value.id),
        offset: value.offset,
      };
    default:
      throw new Error('Unknown background-jobs operation.');
  }
}

function parseOutput(value: unknown, maxBytes: number): OutputSnapshot {
  if (!record(value)) throw new Error('Invalid output snapshot.');
  if (
    typeof value.text !== 'string' ||
    Buffer.byteLength(value.text) > maxBytes
  )
    throw new Error('Invalid or oversized output.');
  const outputText = value.text;
  const totalBytes = value.totalBytes;
  const droppedBytes = value.droppedBytes;
  if (
    typeof totalBytes !== 'number' ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < Buffer.byteLength(outputText) ||
    typeof droppedBytes !== 'number' ||
    !Number.isSafeInteger(droppedBytes) ||
    droppedBytes < 0 ||
    droppedBytes + Buffer.byteLength(outputText) > totalBytes
  )
    throw new Error('Invalid output byte counts.');
  return { text: outputText, totalBytes, droppedBytes };
}

function parseEvent(value: unknown): BackgroundJobEvent {
  if (!record(value)) throw new Error('Invalid background job event.');
  if (
    typeof value.offset !== 'number' ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    (value.stream !== 'stdout' && value.stream !== 'stderr') ||
    typeof value.text !== 'string' ||
    Buffer.byteLength(value.text) > BACKGROUND_JOBS_MAX_EVENT_LINE_BYTES ||
    typeof value.truncated !== 'boolean' ||
    Buffer.byteLength(JSON.stringify(value)) >
      BACKGROUND_JOBS_MAX_EVENT_RECORD_BYTES
  )
    throw new Error('Invalid background job event.');
  return {
    offset: value.offset,
    stream: value.stream,
    text: value.text,
    truncated: value.truncated,
  };
}

function parseEventsSnapshot(value: unknown): BackgroundJobEventsSnapshot {
  if (!record(value) || !Array.isArray(value.events))
    throw new Error('Invalid background job events response.');
  if (
    typeof value.truncated !== 'boolean' ||
    typeof value.complete !== 'boolean' ||
    typeof value.nextOffset !== 'number' ||
    !Number.isSafeInteger(value.nextOffset) ||
    value.nextOffset < 0
  )
    throw new Error('Invalid background job events bounds.');
  const events = value.events.map(parseEvent);
  if (
    Buffer.byteLength(
      JSON.stringify({
        events,
        truncated: value.truncated,
        complete: value.complete,
        nextOffset: value.nextOffset,
      }),
    ) > BACKGROUND_JOBS_MAX_EVENT_RESPONSE_BYTES
  )
    throw new Error('Background job events response exceeded its bound.');
  return {
    events,
    truncated: value.truncated,
    complete: value.complete,
    nextOffset: value.nextOffset,
  };
}

function parseSnapshot(value: unknown): BackgroundJobSnapshot {
  if (!record(value)) throw new Error('Invalid background job snapshot.');
  if (value.env !== undefined || value.argv !== undefined)
    throw new Error('Background job snapshot exposed launch secrets.');
  if (value.timedOut !== undefined && typeof value.timedOut !== 'boolean')
    throw new Error('Invalid timeout fact.');
  const status = value.status;
  if (
    status !== 'running' &&
    status !== 'done' &&
    status !== 'failed' &&
    status !== 'killed'
  )
    throw new Error('Invalid background job status.');
  const createdAt = value.createdAt;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt))
    throw new Error('Invalid background job timestamp.');
  return {
    id: uuid(value.id),
    ownerSession: owner(value.ownerSession),
    title: text(value.title, 'title', BACKGROUND_JOBS_MAX_TITLE_BYTES),
    command: text(value.command, 'command', BACKGROUND_JOBS_MAX_COMMAND_BYTES),
    cwd: text(value.cwd, 'cwd', BACKGROUND_JOBS_MAX_CWD_BYTES),
    ...(value.timeoutMs === undefined
      ? {}
      : { timeoutMs: parseTimeout(value.timeoutMs) }),
    ...(value.events === undefined
      ? {}
      : { events: parseEvents(value.events) }),
    ...(typeof value.pid === 'number' ? { pid: value.pid } : {}),
    status,
    createdAt,
    ...(typeof value.settledAt === 'number'
      ? { settledAt: value.settledAt }
      : {}),
    ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
    ...(typeof value.signal === 'string' ? { signal: value.signal } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(typeof value.timedOut === 'boolean'
      ? { timedOut: value.timedOut }
      : {}),
    ...(typeof value.completionDelivered === 'boolean'
      ? { completionDelivered: value.completionDelivered }
      : {}),
    stdout: parseOutput(value.stdout, BACKGROUND_JOBS_MAX_OUTPUT_BYTES),
    stderr: parseOutput(value.stderr, BACKGROUND_JOBS_STDERR_OUTPUT_BYTES),
  };
}

export function parseBackgroundJobsResponse(
  value: unknown,
): BackgroundJobsResponse {
  if (!record(value) || value.v !== 1 || typeof value.ok !== 'boolean')
    throw new Error('Invalid background-jobs response.');
  if (value.ok && value.job !== undefined) parseSnapshot(value.job);
  if (value.ok && value.jobs !== undefined) {
    if (!Array.isArray(value.jobs))
      throw new Error('Invalid background jobs response.');
    for (const job of value.jobs) parseSnapshot(job);
  }
  if (value.ok && value.events !== undefined) parseEventsSnapshot(value.events);
  return value as BackgroundJobsResponse;
}

export function defaultProcessHostSocketPath(): string {
  return (
    process.env.PI_PROCESS_HOST_SOCKET ??
    path.join(
      process.env.PI_DASHBOARD_STATE_DIR ??
        path.join(
          process.env.HOME ?? process.cwd(),
          '.pi',
          'agent',
          'dashboard',
        ),
      'background-jobs.sock',
    )
  );
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export class BackgroundJobsClient {
  readonly ownerSession: string;
  constructor(
    private readonly socketPath = defaultProcessHostSocketPath(),
    ownerSession = 'default',
  ) {
    this.ownerSession = owner(ownerSession);
  }

  private async request(
    request: BackgroundJobsRequestPayload,
  ): Promise<BackgroundJobsResponse> {
    const payload = jsonLine({ v: 1, ...request });
    if (Buffer.byteLength(payload) > BACKGROUND_JOBS_MAX_LINE_BYTES)
      throw new Error('Background-jobs request exceeded its bound.');
    const connection = await new Promise<Socket>((resolve, reject) => {
      const client = createConnection(this.socketPath);
      client.once('connect', () => resolve(client));
      client.once('error', reject);
    });
    return new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(
        () => {
          connection.destroy();
          reject(new Error('Background-jobs request timed out.'));
        },
        REQUEST_TIMEOUT_MS + (request.op === 'wait' ? request.waitMs : 0),
      );
      connection.setEncoding('utf8');
      connection.on('data', (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > BACKGROUND_JOBS_MAX_RESPONSE_BYTES) {
          clearTimeout(timer);
          connection.destroy();
          reject(new Error('Background-jobs response exceeded its bound.'));
          return;
        }
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          const response = parseBackgroundJobsResponse(
            JSON.parse(buffer.slice(0, newline)),
          );
          if (!response.ok)
            throw Object.assign(
              new Error(response.error ?? 'Background-jobs request failed.'),
              { code: response.code },
            );
          resolve(response);
        } catch (error) {
          reject(error);
        } finally {
          clearTimeout(timer);
          connection.destroy();
        }
      });
      connection.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      connection.write(payload);
    });
  }

  start(
    input: Omit<StartBackgroundJobInput, 'ownerSession'>,
  ): Promise<BackgroundJobSnapshot> {
    return this.request({
      op: 'start',
      input: { ...input, ownerSession: this.ownerSession },
    }).then((response) => {
      if (!response.job)
        throw new Error('Background-jobs host returned no job.');
      return response.job;
    });
  }
  list(): Promise<BackgroundJobSnapshot[]> {
    return this.request({ op: 'list', ownerSession: this.ownerSession }).then(
      (response) => response.jobs ?? [],
    );
  }
  inspect(id: string): Promise<BackgroundJobSnapshot | undefined> {
    return this.request({
      op: 'inspect',
      ownerSession: this.ownerSession,
      id,
    }).then((response) => response.job);
  }
  wait(id: string, waitMs = 0): Promise<BackgroundJobSnapshot> {
    return this.request({
      op: 'wait',
      ownerSession: this.ownerSession,
      id,
      waitMs,
    }).then((response) => {
      if (!response.job) throw new Error('Unknown background job.');
      return response.job;
    });
  }
  stop(ids: readonly string[]): Promise<BackgroundJobSnapshot[]> {
    return this.request({
      op: 'stop',
      ownerSession: this.ownerSession,
      ids: [...new Set(ids)],
    }).then((response) => response.jobs ?? []);
  }
  markDelivered(id: string): Promise<void> {
    return this.request({
      op: 'ack',
      ownerSession: this.ownerSession,
      id,
    }).then(() => undefined);
  }
  events(id: string, offset = 0): Promise<BackgroundJobEventsSnapshot> {
    return this.request({
      op: 'events',
      ownerSession: this.ownerSession,
      id,
      offset,
    }).then((response) => {
      if (!response.events)
        throw new Error('Background-jobs host returned no events.');
      return response.events;
    });
  }
}

export function newBackgroundJobId(): string {
  return randomUUID();
}
export type { BackgroundJobsRequest };
export async function ensureProcessHostDirectory(
  socketPath: string,
): Promise<void> {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
}
