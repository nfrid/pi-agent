import type { SequenceItem } from './types';

const MAX_CANONICAL_DEPTH = 20;
const MAX_CANONICAL_NODES = 1000;

type CanonicalState = {
  nodes: number;
  ancestors: Set<object>;
};

/**
 * A bounded JSON-like representation used only for retry signatures. Unsupported
 * or unusually large values fail closed rather than making unrelated calls look
 * like retries.
 */
function canonicalize(
  value: unknown,
  state: CanonicalState,
  depth = 0,
): string | undefined {
  if (depth > MAX_CANONICAL_DEPTH || state.nodes++ > MAX_CANONICAL_NODES)
    return undefined;

  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : undefined;
    case 'object':
      break;
    default:
      return undefined;
  }

  if (state.ancestors.has(value)) return undefined;
  state.ancestors.add(value);
  let result: string | undefined;
  try {
    if (Array.isArray(value)) {
      const values = value.map((item) => canonicalize(item, state, depth + 1));
      result = values.every((item) => item !== undefined)
        ? `[${values.join(',')}]`
        : undefined;
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        return undefined;
      const keys = Object.keys(value).sort();
      const entries = keys.map((key) => {
        const item = canonicalize(
          (value as Record<string, unknown>)[key],
          state,
          depth + 1,
        );
        return item === undefined
          ? undefined
          : `${JSON.stringify(key)}:${item}`;
      });
      result = entries.every((item) => item !== undefined)
        ? `{${entries.join(',')}}`
        : undefined;
    }
  } catch {
    result = undefined;
  } finally {
    state.ancestors.delete(value);
  }
  return result;
}

function signatureOf(name: string, args: unknown): string | undefined {
  const canonicalArgs = canonicalize(args, { nodes: 0, ancestors: new Set() });
  return canonicalArgs === undefined
    ? undefined
    : `${JSON.stringify(name)}:${canonicalArgs}`;
}

/**
 * Whether a sequence has a failed call whose signature has not been resolved by
 * a later successful call. The input order is the transcript order, so a later
 * failure reopens a signature after an earlier success.
 */
export function hasUnresolvedToolFailure(
  items: readonly SequenceItem[],
): boolean {
  const failed = new Set<string>();
  let unkeyedFailure = false;
  for (const item of items) {
    if (item.type !== 'tool') continue;
    const signature = signatureOf(item.name, item.args);
    if (signature === undefined) {
      if (item.isError) unkeyedFailure = true;
      continue;
    }
    if (item.isError) failed.add(signature);
    else if (item.status === 'complete') failed.delete(signature);
  }
  return unkeyedFailure || failed.size > 0;
}
