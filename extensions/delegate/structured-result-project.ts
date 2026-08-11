import { Value } from 'typebox/value';
import {
  asToolSchema,
  decodePath,
  isJsonValue,
  isPlainObject,
  jsonBytes,
  type NormalizedDelegateResultSpec,
  STRUCTURED_RESULT_CAPS,
  type StructuredProjectionResult,
  type StructuredValidationResult,
} from './structured-result-schema';

function pathForError(path: string): string {
  return path || '/';
}

function addIssue(issues: string[], path: string, message: string): void {
  if (issues.length >= STRUCTURED_RESULT_CAPS.maxValidationErrors) return;
  const text = `${pathForError(path)}: ${message}`;
  issues.push(text.slice(0, STRUCTURED_RESULT_CAPS.maxValidationErrorBytes));
}

function freezeJson(value: unknown): unknown {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!Array.isArray(current) && !isPlainObject(current)) continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) pending.push(...current);
    else pending.push(...Object.values(current));
    Object.freeze(current);
  }
  return value;
}

/** Validate one child channel result against the already-normalized schema. */
export function validateStructuredResult(
  spec: NormalizedDelegateResultSpec,
  value: unknown,
): StructuredValidationResult {
  if (!isJsonValue(value))
    return { valid: false, errors: ['/: result must be a JSON value'] };
  let bytes: number;
  try {
    bytes = jsonBytes(value, 'delegate result');
  } catch (error) {
    return {
      valid: false,
      errors: [String(error instanceof Error ? error.message : error)],
    };
  }
  if (bytes > STRUCTURED_RESULT_CAPS.resultBytes)
    return {
      valid: false,
      errors: [
        `/: result exceeds the ${STRUCTURED_RESULT_CAPS.resultBytes}-byte limit`,
      ],
    };
  const errors: string[] = [];
  const schema = asToolSchema(spec.schema);
  try {
    if (!Value.Check(schema, value)) {
      for (const error of Value.Errors(schema, value).slice(
        0,
        STRUCTURED_RESULT_CAPS.maxValidationErrors,
      ))
        addIssue(errors, error.instancePath, error.message);
    }
  } catch {
    return {
      valid: false,
      errors: ['/: result validation exceeded bounded traversal limits'],
    };
  }
  return errors.length
    ? { valid: false, errors }
    : { valid: true, value: freezeJson(value), errors: [] };
}

function selectPath(
  value: unknown,
  segments: string[],
): { present: boolean; value?: unknown } {
  if (segments.length === 0) return { present: true, value };
  const [segment, ...rest] = segments;
  if (segment === '*') {
    if (!Array.isArray(value)) return { present: false };
    const selected: unknown[] = [];
    for (const item of value) {
      const result = selectPath(item, rest);
      selected.push(result.present ? result.value : undefined);
    }
    return { present: true, value: selected };
  }
  if (!isPlainObject(value) || !Object.hasOwn(value, segment))
    return { present: false };
  return selectPath(value[segment], rest);
}

function projectionFragment(
  value: unknown,
  segments: string[],
): { present: boolean; value?: unknown } {
  if (segments.length === 0) return { present: true, value };
  const [segment, ...rest] = segments;
  if (segment === '*') {
    if (!Array.isArray(value)) return { present: false };
    const items = value.map((item) => {
      const selected = projectionFragment(item, rest);
      if (!selected.present) return Object.create(null);
      return selected.value;
    });
    return { present: true, value: items };
  }
  if (!isPlainObject(value) || !Object.hasOwn(value, segment))
    return { present: false };
  const selected = projectionFragment(value[segment], rest);
  if (!selected.present) return { present: false };
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  result[segment] = selected.value;
  return { present: true, value: result };
}

/** Resolve one schema path for an artifact view without exposing any other value. */
export function selectStructuredPath(
  value: unknown,
  path: string,
): { present: boolean; value?: unknown } {
  return selectPath(value, decodePath(path));
}

/** Select only the validated static paths, preserving wildcard array shape. */
export function projectStructuredResult(
  spec: NormalizedDelegateResultSpec,
  value: unknown,
): StructuredProjectionResult {
  if (spec.projection.length === 0) return { omittedPaths: [] };
  const target: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  const omittedPaths: string[] = [];
  for (const path of spec.projection) {
    const segments = decodePath(path);
    const selected = selectPath(value, segments);
    if (!selected.present) continue;
    const fragment = projectionFragment(value, segments);
    if (!fragment.present) continue;
    if (segments.length === 0) {
      const bytes = jsonBytes(fragment.value, 'projection');
      if (bytes > STRUCTURED_RESULT_CAPS.projectionBytes) {
        omittedPaths.push(path);
        continue;
      }
      return { value: fragment.value, omittedPaths };
    }
    const candidate = fragment.value as Record<string, unknown>;
    const merged = mergeProjection(target, candidate);
    if (
      jsonBytes(merged, 'projection') > STRUCTURED_RESULT_CAPS.projectionBytes
    ) {
      omittedPaths.push(path);
      continue;
    }
    for (const [key, item] of Object.entries(merged)) target[key] = item;
  }
  if (Object.keys(target).length === 0) return { omittedPaths };
  return { value: target, omittedPaths };
}

function mergeProjectionValue(left: unknown, right: unknown): unknown {
  if (isPlainObject(left) && isPlainObject(right))
    return mergeProjection(left, right);
  if (Array.isArray(left) && Array.isArray(right)) {
    return right.map((item, index) =>
      index < left.length ? mergeProjectionValue(left[index], item) : item,
    );
  }
  return right;
}

function mergeProjection(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(left)) result[key] = value;
  for (const [key, value] of Object.entries(right))
    result[key] = Object.hasOwn(result, key)
      ? mergeProjectionValue(result[key], value)
      : value;
  return result;
}
