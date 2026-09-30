import { type Static, Type } from 'typebox';
import { tryParseSchema } from './utils.js';

/** Exact persisted identity for one ordinary user request and its final answer. */
export const ResponseClosureSchema = Type.Refine(
  Type.Object(
    {
      requestMessageId: Type.String({ minLength: 1, maxLength: 512 }),
      finalMessageId: Type.String({ minLength: 1, maxLength: 512 }),
      startedAt: Type.Number({ minimum: 0 }),
      endedAt: Type.Number({ minimum: 0 }),
      liveRequestMessageId: Type.Optional(
        Type.String({ minLength: 1, maxLength: 512 }),
      ),
      liveFinalMessageId: Type.Optional(
        Type.String({ minLength: 1, maxLength: 512 }),
      ),
    },
    { additionalProperties: false },
  ),
  (closure) =>
    Number.isFinite(closure.startedAt) &&
    Number.isFinite(closure.endedAt) &&
    closure.endedAt >= closure.startedAt,
);
export type ResponseClosure = Static<typeof ResponseClosureSchema>;

export function tryParseResponseClosure(
  value: unknown,
): ResponseClosure | undefined {
  return tryParseSchema(ResponseClosureSchema, value);
}

export const RESPONSE_CLOSURE_MARKER_TYPE = 'response-closure';

export const ResponseClosureMarkerSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 512 }),
    parentId: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
    ),
    timestamp: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    type: Type.Literal('custom'),
    customType: Type.Literal(RESPONSE_CLOSURE_MARKER_TYPE),
    data: ResponseClosureSchema,
  },
  { additionalProperties: false },
);
export type ResponseClosureMarker = Static<typeof ResponseClosureMarkerSchema>;
