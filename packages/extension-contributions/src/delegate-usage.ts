/** Bounded provider usage projected for built-in delegate surfaces and history. */
import { type Static, Type } from 'typebox';

const MAX_DELEGATE_USAGE_VALUE = Number.MAX_SAFE_INTEGER;

export const DelegateUsageSchema = Type.Object(
  {
    input: Type.Integer({ minimum: 0, maximum: MAX_DELEGATE_USAGE_VALUE }),
    output: Type.Integer({ minimum: 0, maximum: MAX_DELEGATE_USAGE_VALUE }),
    cacheRead: Type.Integer({
      minimum: 0,
      maximum: MAX_DELEGATE_USAGE_VALUE,
    }),
    cacheWrite: Type.Integer({
      minimum: 0,
      maximum: MAX_DELEGATE_USAGE_VALUE,
    }),
    contextTokens: Type.Integer({
      minimum: 0,
      maximum: MAX_DELEGATE_USAGE_VALUE,
    }),
    cost: Type.Number({ minimum: 0, maximum: MAX_DELEGATE_USAGE_VALUE }),
    turns: Type.Integer({ minimum: 0, maximum: MAX_DELEGATE_USAGE_VALUE }),
    contextWindow: Type.Optional(
      Type.Integer({ minimum: 0, maximum: MAX_DELEGATE_USAGE_VALUE }),
    ),
  },
  { additionalProperties: false },
);
export type DelegateUsage = Static<typeof DelegateUsageSchema>;

/** Project untrusted persisted or runtime usage into the bounded wire shape. */
export function projectDelegateUsage(
  value: unknown,
): DelegateUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  const source = value as Record<string, unknown>;
  const integer = (name: string): number | undefined => {
    const candidate = source[name];
    return typeof candidate === 'number' &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0
      ? candidate
      : undefined;
  };
  const cost = source.cost;
  const input = integer('input');
  const output = integer('output');
  const cacheRead = integer('cacheRead');
  const cacheWrite = integer('cacheWrite');
  const contextTokens = integer('contextTokens');
  const turns = integer('turns');
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    contextTokens === undefined ||
    typeof cost !== 'number' ||
    !Number.isFinite(cost) ||
    cost < 0 ||
    cost > MAX_DELEGATE_USAGE_VALUE ||
    turns === undefined
  )
    return undefined;
  const contextWindow = integer('contextWindow');
  if (
    input === 0 &&
    output === 0 &&
    cacheRead === 0 &&
    cacheWrite === 0 &&
    contextTokens === 0 &&
    cost === 0 &&
    turns === 0 &&
    contextWindow === undefined
  )
    return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    contextTokens,
    cost,
    turns,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}
