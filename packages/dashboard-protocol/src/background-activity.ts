import { type Static, Type } from 'typebox';
import { MAX_ID, MAX_PATH } from './limits.js';
import { parseSchema, tryParseSchema } from './utils.js';

const BackgroundSessionIdSchema = Type.String({
  minLength: 1,
  maxLength: MAX_ID,
  pattern: '^[a-zA-Z0-9._-]+$',
});
const BackgroundJobIdSchema = Type.String({
  minLength: 36,
  maxLength: 36,
  pattern:
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const BackgroundJobStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('done'),
  Type.Literal('failed'),
  Type.Literal('killed'),
]);
export type BackgroundJobStatus = Static<typeof BackgroundJobStatusSchema>;

const BackgroundOutputStatsSchema = Type.Object(
  {
    totalBytes: Type.Integer({ minimum: 0 }),
    droppedBytes: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type BackgroundOutputStats = Static<typeof BackgroundOutputStatsSchema>;

/** Dashboard-safe process metadata. Output text is read through the log API. */
export const BackgroundJobSchema = Type.Object(
  {
    id: BackgroundJobIdSchema,
    sessionId: BackgroundSessionIdSchema,
    title: Type.String({ minLength: 1, maxLength: 8 * 1024 }),
    command: Type.String({ minLength: 1, maxLength: 256 * 1024 }),
    cwd: Type.String({ minLength: 1, maxLength: MAX_PATH }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    events: Type.Optional(Type.Boolean()),
    pid: Type.Optional(Type.Integer({ minimum: 1 })),
    status: BackgroundJobStatusSchema,
    createdAt: Type.Number(),
    settledAt: Type.Optional(Type.Number()),
    exitCode: Type.Optional(Type.Integer()),
    signal: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    error: Type.Optional(Type.String({ maxLength: 1_024 })),
    timedOut: Type.Optional(Type.Boolean()),
    stdout: BackgroundOutputStatsSchema,
    stderr: BackgroundOutputStatsSchema,
  },
  { additionalProperties: false },
);
export type BackgroundJob = Static<typeof BackgroundJobSchema>;

export const BackgroundJobsInputSchema = Type.Object(
  { sessionId: BackgroundSessionIdSchema },
  { additionalProperties: false },
);
export type BackgroundJobsInput = Static<typeof BackgroundJobsInputSchema>;

export const BackgroundJobsResponseSchema = Type.Object(
  {
    sessionId: BackgroundSessionIdSchema,
    jobs: Type.Readonly(Type.Array(BackgroundJobSchema, { maxItems: 64 })),
  },
  { additionalProperties: false },
);
export type BackgroundJobsResponse = Static<
  typeof BackgroundJobsResponseSchema
>;

export const BackgroundJobEventsInputSchema = Type.Object(
  {
    sessionId: BackgroundSessionIdSchema,
    jobId: BackgroundJobIdSchema,
    offset: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
export type BackgroundJobEventsInput = Static<
  typeof BackgroundJobEventsInputSchema
>;

export const BackgroundJobEventSchema = Type.Object(
  {
    offset: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    stream: Type.Union([Type.Literal('stdout'), Type.Literal('stderr')]),
    text: Type.String({ maxLength: 64 * 1024 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type BackgroundJobEvent = Static<typeof BackgroundJobEventSchema>;

export const BackgroundJobEventsResponseSchema = Type.Object(
  {
    sessionId: BackgroundSessionIdSchema,
    jobId: BackgroundJobIdSchema,
    events: Type.Readonly(
      Type.Array(BackgroundJobEventSchema, { maxItems: 512 }),
    ),
    /** Records before the requested offset were pruned. */
    truncated: Type.Boolean(),
    /** A settled job has no more records after nextOffset. */
    complete: Type.Boolean(),
    nextOffset: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type BackgroundJobEventsResponse = Static<
  typeof BackgroundJobEventsResponseSchema
>;

export const BackgroundJobsSubscribeInputSchema = Type.Object(
  {
    sessionId: BackgroundSessionIdSchema,
    lastEventId: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  { additionalProperties: false },
);
export type BackgroundJobsSubscribeInput = Static<
  typeof BackgroundJobsSubscribeInputSchema
>;

export const BackgroundJobEventsSubscribeInputSchema = Type.Object(
  {
    sessionId: BackgroundSessionIdSchema,
    jobId: BackgroundJobIdSchema,
    offset: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    lastEventId: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  { additionalProperties: false },
);
export type BackgroundJobEventsSubscribeInput = Static<
  typeof BackgroundJobEventsSubscribeInputSchema
>;

export function parseBackgroundJobsInput(value: unknown): BackgroundJobsInput {
  return parseSchema(BackgroundJobsInputSchema, value, 'background jobs input');
}
export function parseBackgroundJobsResponse(
  value: unknown,
): BackgroundJobsResponse {
  return parseSchema(
    BackgroundJobsResponseSchema,
    value,
    'background jobs response',
  );
}
export function parseBackgroundJobEventsInput(
  value: unknown,
): BackgroundJobEventsInput {
  return parseSchema(
    BackgroundJobEventsInputSchema,
    value,
    'background job events input',
  );
}
export function parseBackgroundJobEventsResponse(
  value: unknown,
): BackgroundJobEventsResponse {
  return parseSchema(
    BackgroundJobEventsResponseSchema,
    value,
    'background job events response',
  );
}
export const parseBackgroundJobsSubscribeInput = (
  value: unknown,
): BackgroundJobsSubscribeInput =>
  parseSchema(
    BackgroundJobsSubscribeInputSchema,
    value,
    'background jobs subscription input',
  );
export const parseBackgroundJobEventsSubscribeInput = (
  value: unknown,
): BackgroundJobEventsSubscribeInput =>
  parseSchema(
    BackgroundJobEventsSubscribeInputSchema,
    value,
    'background job events subscription input',
  );
export const tryParseBackgroundJobsResponse = (
  value: unknown,
): BackgroundJobsResponse | undefined =>
  tryParseSchema(BackgroundJobsResponseSchema, value);
export const tryParseBackgroundJobEventsResponse = (
  value: unknown,
): BackgroundJobEventsResponse | undefined =>
  tryParseSchema(BackgroundJobEventsResponseSchema, value);
