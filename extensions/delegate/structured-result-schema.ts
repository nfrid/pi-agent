import type { TSchema } from 'typebox';

/**
 * The intentionally small result-contract surface.  It is JSON Schema-shaped,
 * but it is not a general JSON Schema interpreter: normalization rejects every
 * keyword outside the list below before a child is prepared.
 *
 * Paths use a JSON-pointer-like grammar documented in docs/delegation.md.  A
 * `*` segment is only valid when it selects the items of an array schema.
 */
export interface DelegateResultSpecInput {
  schema: unknown;
  projection?: unknown;
  views?: unknown;
}

export interface JsonSchemaNode {
  [key: string]: unknown;
}

export interface NormalizedDelegateResultSpec {
  schema: JsonSchemaNode;
  projection: string[];
  views: Record<string, string>;
  schemaBytes: number;
}

export interface StructuredValidationResult {
  valid: boolean;
  value?: unknown;
  errors: string[];
}

export interface StructuredProjectionResult {
  value?: unknown;
  omittedPaths: string[];
}

export interface StructuredArtifacts {
  views: Record<string, { handle: string; size: number }>;
}

export const STRUCTURED_RESULT_CAPS = {
  schemaBytes: 16 * 1024,
  schemaDepth: 8,
  schemaNodes: 128,
  maxProperties: 32,
  maxRequired: 32,
  maxEnumItems: 32,
  maxEnumValueBytes: 2 * 1024,
  maxArrayItems: 64,
  maxStringLength: 4 * 1024,
  maxPathBytes: 256,
  maxProjectionPaths: 32,
  projectionBytes: 8 * 1024,
  maxViews: 16,
  maxViewNameBytes: 64,
  resultBytes: 64 * 1024,
  maxValidationErrors: 16,
  maxValidationErrorBytes: 240,
} as const;

/** Alias retained as a discoverable name for callers that prefer "limits". */
export const STRUCTURED_RESULT_LIMITS = STRUCTURED_RESULT_CAPS;

const SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
]);

const TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

const SAFE_VIEW_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(['.', '..']);
const DANGEROUS_PROPERTY_NAMES = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function jsonBytes(value: unknown, label: string): number {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-compatible`);
  }
  if (text === undefined) throw new Error(`${label} must be JSON-compatible`);
  return byteLength(text);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): boolean {
  const pending: Array<{ value: unknown; exit?: boolean }> = [{ value }];
  const active = new WeakSet<object>();
  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame) continue;
    const current = frame.value;
    if (frame.exit) {
      active.delete(current as object);
      continue;
    }
    if (current === null) continue;
    if (typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (!Array.isArray(current) && !isPlainObject(current)) return false;
    if (active.has(current)) return false;
    active.add(current);
    pending.push({ value: current, exit: true });
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index--)
        pending.push({ value: current[index] });
      continue;
    }
    const entries = Object.entries(current);
    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, item] = entries[index];
      if (DANGEROUS_PROPERTY_NAMES.has(key)) return false;
      pending.push({ value: item });
    }
  }
  return true;
}

function safeInteger(value: unknown, label: string, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    throw new Error(`${label} must be an integer from 0 to ${max}`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${label} must be a finite number`);
  return value;
}

function matchesSchemaType(type: string, value: unknown): boolean {
  if (type === 'null') return value === null;
  if (type === 'object') return isPlainObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'integer')
    return typeof value === 'number' && Number.isSafeInteger(value);
  return typeof value === 'number' && Number.isFinite(value);
}

function orderedObject(
  entries: Array<[string, unknown]>,
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, value] of entries) result[key] = value;
  return result;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null)
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (
      !Array.isArray(left) ||
      !Array.isArray(right) ||
      left.length !== right.length
    )
      return false;
    return left.every((value, index) => sameJson(value, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]),
      )
    );
  }
  return false;
}

interface SchemaCounters {
  depth: number;
  nodes: { value: number };
}

function normalizeSchemaNode(
  input: unknown,
  counters: SchemaCounters,
): JsonSchemaNode {
  if (!isPlainObject(input))
    throw new Error('result schema nodes must be JSON objects');
  counters.nodes.value++;
  if (counters.nodes.value > STRUCTURED_RESULT_CAPS.schemaNodes)
    throw new Error(
      `result schema exceeds the ${STRUCTURED_RESULT_CAPS.schemaNodes}-node limit`,
    );
  if (counters.depth > STRUCTURED_RESULT_CAPS.schemaDepth)
    throw new Error(
      `result schema exceeds the ${STRUCTURED_RESULT_CAPS.schemaDepth}-level depth limit`,
    );

  for (const key of Object.keys(input))
    if (!SCHEMA_KEYS.has(key))
      throw new Error(`Unsupported result schema keyword: ${key}`);

  const type = input.type;
  if (typeof type !== 'string' || !TYPES.has(type))
    throw new Error('result schema requires one supported string type');
  const typeKeys: Record<string, Set<string>> = {
    object: new Set([
      'type',
      'properties',
      'required',
      'additionalProperties',
      'enum',
    ]),
    array: new Set([
      'type',
      'items',
      'minItems',
      'maxItems',
      'uniqueItems',
      'enum',
    ]),
    string: new Set(['type', 'minLength', 'maxLength', 'enum']),
    number: new Set([
      'type',
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'multipleOf',
      'enum',
    ]),
    integer: new Set([
      'type',
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'multipleOf',
      'enum',
    ]),
    boolean: new Set(['type', 'enum']),
    null: new Set(['type', 'enum']),
  };
  for (const key of Object.keys(input))
    if (!typeKeys[type].has(key))
      throw new Error(`Unsupported result schema keyword for ${type}: ${key}`);

  const entries: Array<[string, unknown]> = [['type', type]];

  if (input.enum !== undefined) {
    if (!Array.isArray(input.enum) || input.enum.length === 0)
      throw new Error('result schema enum must be a non-empty array');
    if (input.enum.length > STRUCTURED_RESULT_CAPS.maxEnumItems)
      throw new Error(
        `result schema enum exceeds the ${STRUCTURED_RESULT_CAPS.maxEnumItems}-item limit`,
      );
    const values = input.enum.map((value) => {
      if (!isJsonValue(value))
        throw new Error('result schema enum values must be JSON values');
      if (!matchesSchemaType(type, value))
        throw new Error(`result schema enum value does not match type ${type}`);
      if (
        jsonBytes(value, 'result schema enum value') >
        STRUCTURED_RESULT_CAPS.maxEnumValueBytes
      )
        throw new Error(
          `result schema enum values exceed the ${STRUCTURED_RESULT_CAPS.maxEnumValueBytes}-byte limit`,
        );
      return value;
    });
    if (
      values.some((value, index) =>
        values.slice(0, index).some((prior) => sameJson(prior, value)),
      )
    )
      throw new Error('result schema enum contains duplicate values');
    entries.push(['enum', values]);
  }

  if (type === 'object') {
    if (
      input.additionalProperties !== undefined &&
      input.additionalProperties !== false
    )
      throw new Error(
        'result schema only supports additionalProperties: false',
      );
    const properties = input.properties;
    if (properties !== undefined && !isPlainObject(properties))
      throw new Error('result schema object properties must be an object');
    const propertyEntries = Object.entries(properties ?? {});
    if (propertyEntries.length > STRUCTURED_RESULT_CAPS.maxProperties)
      throw new Error(
        `result schema exceeds the ${STRUCTURED_RESULT_CAPS.maxProperties}-property limit`,
      );
    const normalizedProperties: Record<string, unknown> = Object.create(
      null,
    ) as Record<string, unknown>;
    for (const [name, child] of propertyEntries.sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (!name || byteLength(name) > STRUCTURED_RESULT_CAPS.maxPathBytes)
        throw new Error('result schema property names are empty or too long');
      if (DANGEROUS_PROPERTY_NAMES.has(name))
        throw new Error(
          `result schema property name is not supported: ${name}`,
        );
      normalizedProperties[name] = normalizeSchemaNode(child, {
        depth: counters.depth + 1,
        nodes: counters.nodes,
      });
    }
    entries.push(['properties', normalizedProperties]);
    const required = input.required;
    if (required !== undefined) {
      if (!Array.isArray(required))
        throw new Error('result schema required must be an array');
      if (required.length > STRUCTURED_RESULT_CAPS.maxRequired)
        throw new Error(
          `result schema required exceeds the ${STRUCTURED_RESULT_CAPS.maxRequired}-item limit`,
        );
      const names = required.map((name) => {
        if (
          typeof name !== 'string' ||
          !name ||
          !Object.hasOwn(properties ?? {}, name)
        )
          throw new Error(
            'result schema required must name declared properties',
          );
        return name;
      });
      if (new Set(names).size !== names.length)
        throw new Error('result schema required contains duplicate properties');
      entries.push(['required', [...names].sort()]);
    }
    // Closed objects are deliberate, even when the input omitted the keyword:
    // an extra child property must never silently become a successful result.
    entries.push(['additionalProperties', false]);
  } else if (type === 'array') {
    if (!isPlainObject(input.items))
      throw new Error('result schema arrays require one items schema');
    const minItems =
      input.minItems === undefined
        ? undefined
        : safeInteger(
            input.minItems,
            'result schema minItems',
            STRUCTURED_RESULT_CAPS.maxArrayItems,
          );
    const maxItems =
      input.maxItems === undefined
        ? STRUCTURED_RESULT_CAPS.maxArrayItems
        : safeInteger(
            input.maxItems,
            'result schema maxItems',
            STRUCTURED_RESULT_CAPS.maxArrayItems,
          );
    if (minItems !== undefined && minItems > maxItems)
      throw new Error('result schema minItems cannot exceed maxItems');
    if (minItems !== undefined) entries.push(['minItems', minItems]);
    entries.push(['maxItems', maxItems]);
    if (input.uniqueItems !== undefined) {
      if (typeof input.uniqueItems !== 'boolean')
        throw new Error('result schema uniqueItems must be boolean');
      entries.push(['uniqueItems', input.uniqueItems]);
    }
    entries.push([
      'items',
      normalizeSchemaNode(input.items, {
        depth: counters.depth + 1,
        nodes: counters.nodes,
      }),
    ]);
  } else if (type === 'string') {
    const minLength =
      input.minLength === undefined
        ? undefined
        : safeInteger(
            input.minLength,
            'result schema minLength',
            STRUCTURED_RESULT_CAPS.maxStringLength,
          );
    const maxLength =
      input.maxLength === undefined
        ? STRUCTURED_RESULT_CAPS.maxStringLength
        : safeInteger(
            input.maxLength,
            'result schema maxLength',
            STRUCTURED_RESULT_CAPS.maxStringLength,
          );
    if (minLength !== undefined && minLength > maxLength)
      throw new Error('result schema minLength cannot exceed maxLength');
    if (minLength !== undefined) entries.push(['minLength', minLength]);
    entries.push(['maxLength', maxLength]);
  } else if (type === 'number' || type === 'integer') {
    const numericKeys = [
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'multipleOf',
    ] as const;
    for (const key of numericKeys) {
      if (input[key] !== undefined) {
        const value = finiteNumber(input[key], `result schema ${key}`);
        if (key === 'multipleOf' && value <= 0)
          throw new Error('result schema multipleOf must be positive');
        entries.push([key, value]);
      }
    }
    const minimum = input.minimum ?? input.exclusiveMinimum;
    const maximum = input.maximum ?? input.exclusiveMaximum;
    if (
      minimum !== undefined &&
      maximum !== undefined &&
      finiteNumber(minimum, 'result schema minimum') >
        finiteNumber(maximum, 'result schema maximum')
    )
      throw new Error('result schema minimum cannot exceed maximum');
  }

  return orderedObject(entries);
}

function encodePathSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function decodePath(path: unknown): string[] {
  if (
    typeof path !== 'string' ||
    !path ||
    byteLength(path) > STRUCTURED_RESULT_CAPS.maxPathBytes
  )
    throw new Error(
      `result paths must be non-empty UTF-8 strings of at most ${STRUCTURED_RESULT_CAPS.maxPathBytes} bytes`,
    );
  if (path === '/') return [];
  if (!path.startsWith('/'))
    throw new Error(`Invalid result path "${path}": paths must start with /`);
  const raw = path.slice(1).split('/');
  if (raw.some((segment) => segment.length === 0))
    throw new Error(
      `Invalid result path "${path}": empty segments are not supported`,
    );
  return raw.map((segment) => {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment))
      throw new Error(
        `Invalid result path "${path}": escaping segments are not supported`,
      );
    if (/~(?![01])/.test(segment))
      throw new Error(`Invalid result path "${path}": bad ~ escape`);
    const decoded = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      !decoded ||
      decoded.includes('\u0000') ||
      DANGEROUS_PROPERTY_NAMES.has(decoded)
    )
      throw new Error(`Invalid result path "${path}": unsupported segment`);
    return decoded;
  });
}

function canonicalPath(segments: string[]): string {
  return segments.length === 0
    ? '/'
    : `/${segments.map(encodePathSegment).join('/')}`;
}

function schemaAtPath(
  root: JsonSchemaNode,
  segments: string[],
  path: string,
): void {
  let schema: JsonSchemaNode = root;
  for (const segment of segments) {
    const type = schema.type;
    if (segment === '*') {
      if (type !== 'array' || !isPlainObject(schema.items))
        throw new Error(
          `Invalid result path "${path}": * must select array items`,
        );
      schema = schema.items;
      continue;
    }
    if (
      type !== 'object' ||
      !isPlainObject(schema.properties) ||
      !Object.hasOwn(schema.properties, segment)
    )
      throw new Error(
        `Invalid result path "${path}": segment is not declared by the schema`,
      );
    schema = schema.properties[segment] as JsonSchemaNode;
  }
}

function normalizePathList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error(`${label} must be an array of paths`);
  if (value.length > STRUCTURED_RESULT_CAPS.maxProjectionPaths)
    throw new Error(
      `${label} exceeds the ${STRUCTURED_RESULT_CAPS.maxProjectionPaths}-path limit`,
    );
  const paths = value.map((candidate) => {
    const segments = decodePath(candidate);
    const normalized = canonicalPath(segments);
    if (normalized !== candidate)
      throw new Error(
        `Invalid ${label} path "${String(candidate)}": use canonical escaping`,
      );
    return normalized;
  });
  if (new Set(paths).size !== paths.length)
    throw new Error(`${label} contains duplicate paths`);
  return paths;
}

function normalizeViews(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isPlainObject(value))
    throw new Error('result views must be an object of name to path');
  const entries = Object.entries(value);
  if (entries.length > STRUCTURED_RESULT_CAPS.maxViews)
    throw new Error(
      `result views exceed the ${STRUCTURED_RESULT_CAPS.maxViews}-view limit`,
    );
  const views: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [name, candidate] of entries.sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (
      !SAFE_VIEW_NAME_RE.test(name) ||
      byteLength(name) > STRUCTURED_RESULT_CAPS.maxViewNameBytes
    )
      throw new Error(`Invalid result view name "${name}"`);
    const segments = decodePath(candidate);
    if (segments.length === 0)
      throw new Error(
        `Invalid result view path "${String(candidate)}": a named view cannot expose the complete result`,
      );
    const normalized = canonicalPath(segments);
    if (normalized !== candidate)
      throw new Error(
        `Invalid result view path "${String(candidate)}": use canonical escaping`,
      );
    views[name] = normalized;
  }
  return views;
}

/** Validate, close, normalize, and bound a public result specification. */
export function normalizeDelegateResultSpec(
  input: DelegateResultSpecInput | undefined,
): NormalizedDelegateResultSpec | undefined {
  if (input === undefined) return undefined;
  if (!isPlainObject(input))
    throw new Error('delegate result specification must be an object');
  for (const key of Object.keys(input))
    if (!new Set(['schema', 'projection', 'views']).has(key))
      throw new Error(
        `Unsupported delegate result specification field: ${key}`,
      );
  const schema = normalizeSchemaNode(input.schema, {
    depth: 1,
    nodes: { value: 0 },
  });
  const schemaBytes = jsonBytes(schema, 'result schema');
  if (schemaBytes > STRUCTURED_RESULT_CAPS.schemaBytes)
    throw new Error(
      `result schema exceeds the ${STRUCTURED_RESULT_CAPS.schemaBytes}-byte limit`,
    );
  const projection = normalizePathList(input.projection, 'projection');
  const views = normalizeViews(input.views);
  for (const path of projection) schemaAtPath(schema, decodePath(path), path);
  for (const [name, path] of Object.entries(views)) {
    try {
      schemaAtPath(schema, decodePath(path), path);
    } catch (error) {
      throw new Error(
        `Invalid result view "${name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { schema, projection, views, schemaBytes };
}

/** Convert a normalized declarative schema to the SDK's TypeBox boundary. */
export function asToolSchema(schema: JsonSchemaNode): TSchema {
  return schema as TSchema;
}

export {
  byteLength,
  canonicalPath,
  decodePath,
  isJsonValue,
  isPlainObject,
  jsonBytes,
  sameJson,
};
