import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { type RuntimeLiveState, RuntimeLiveStateSchema } from './schemas.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown, max = 4096): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= max
  );
}

export function safeIdentifier(value: unknown, max: number): value is string {
  return (
    nonEmptyString(value, max) &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

export function onlyKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function normalizeSchemaValue<T extends TSchema>(
  schema: T,
  value: unknown,
  label: string,
): Static<T> {
  if (!Value.Check(schema, value)) throw new Error(`Invalid ${label}.`);
  return value as Static<T>;
}

export function parseSchema<T extends TSchema>(
  schema: T,
  value: unknown,
  label = 'value',
): Static<T> {
  return normalizeSchemaValue(schema, value, label);
}
export function tryParseSchema<T extends TSchema>(
  schema: T,
  value: unknown,
): Static<T> | undefined {
  return Value.Check(schema, value) ? (value as Static<T>) : undefined;
}

export function isRuntimeLiveState(value: unknown): value is RuntimeLiveState {
  return Value.Check(RuntimeLiveStateSchema, value);
}
