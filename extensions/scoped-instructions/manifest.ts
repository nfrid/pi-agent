import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const MANIFEST_VERSION = 1;
export const MAX_RULE_COUNT = 64;
export const MAX_FILES_PER_RULE = 8;

export type MutationIntent = 'edit' | 'write';

export interface ScopedRule {
  id: string;
  scope: string;
  intents: MutationIntent[];
  instructionFiles: string[];
  critical: boolean;
  texts: Array<{ path: string; text: string; hash: string }>;
  hash: string;
}

export interface ParsedScopedRule {
  id: string;
  scope: string;
  intents: MutationIntent[];
  instructionFiles: string[];
  critical: boolean;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function safeRelative(value: unknown, kind: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes('\\') ||
    value.includes('\0')
  )
    throw new Error(`${kind} must be a non-empty portable relative path`);
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..'))
    throw new Error(`${kind} contains an empty, dot, or traversal segment`);
  return value;
}

function safeScope(value: unknown): string {
  if (value === '.') return '.';
  if (typeof value !== 'string' || !value.endsWith('/'))
    throw new Error('scope must be "." or end in "/"');
  return safeRelative(value.slice(0, -1), 'scope');
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
  kind: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  )
    throw new Error(`${kind} must contain exactly: ${expected.join(', ')}`);
}

/** Parse and validate only the manifest envelope, preserving rule iteration order. */
export function parseManifestEnvelope(source: string): unknown[] {
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('manifest must be an object');
  const object = parsed as Record<string, unknown>;
  exactKeys(object, ['version', 'rules'], 'manifest');
  if (object.version !== MANIFEST_VERSION)
    throw new Error(
      `unsupported version ${String(object.version)} (expected ${MANIFEST_VERSION})`,
    );
  if (!Array.isArray(object.rules)) throw new Error('rules must be an array');
  if (object.rules.length > MAX_RULE_COUNT)
    throw new Error(
      `manifest exceeds ${MAX_RULE_COUNT} rule limit (${object.rules.length} rules)`,
    );
  return object.rules;
}

/** Validate one rule so secure loading can retain legacy validation/I/O order. */
export function parseManifestRule(
  candidate: unknown,
  index: number,
  ids: Set<string>,
): ParsedScopedRule {
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    Array.isArray(candidate)
  )
    throw new Error(`rule ${index} must be an object`);
  const rule = candidate as Record<string, unknown>;
  exactKeys(
    rule,
    ['id', 'scope', 'intents', 'instructionFiles', 'critical'],
    `rule ${index}`,
  );
  if (
    typeof rule.id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rule.id)
  )
    throw new Error(`rule ${index} has an invalid id`);
  if (ids.has(rule.id)) throw new Error(`duplicate rule id: ${rule.id}`);
  ids.add(rule.id);
  const scope = safeScope(rule.scope);
  if (
    !Array.isArray(rule.intents) ||
    rule.intents.length === 0 ||
    rule.intents.some((intent) => intent !== 'edit' && intent !== 'write') ||
    new Set(rule.intents).size !== rule.intents.length
  )
    throw new Error(`rule ${rule.id} has invalid or duplicate intents`);
  if (
    !Array.isArray(rule.instructionFiles) ||
    rule.instructionFiles.length === 0
  )
    throw new Error(`rule ${rule.id} requires instructionFiles`);
  if (rule.instructionFiles.length > MAX_FILES_PER_RULE)
    throw new Error(
      `rule ${rule.id} exceeds ${MAX_FILES_PER_RULE} instruction file limit (${rule.instructionFiles.length} files)`,
    );
  const instructionFiles = rule.instructionFiles.map((file) =>
    safeRelative(file, `rule ${rule.id} instruction file`),
  );
  if (new Set(instructionFiles).size !== instructionFiles.length)
    throw new Error(`rule ${rule.id} has duplicate instruction files`);
  if (typeof rule.critical !== 'boolean')
    throw new Error(`rule ${rule.id} critical must be boolean`);
  return {
    id: rule.id,
    scope,
    intents: rule.intents as MutationIntent[],
    instructionFiles,
    critical: rule.critical,
  };
}

/** Parse and strictly validate the complete filesystem-independent schema. */
export function parseManifest(source: string): ParsedScopedRule[] {
  const ids = new Set<string>();
  return parseManifestEnvelope(source).map((candidate, index) =>
    parseManifestRule(candidate, index, ids),
  );
}

/** Add already-securely-loaded instruction text without changing rule order. */
export function buildRule(
  rule: ParsedScopedRule,
  loadedTexts: Array<{ path: string; text: string }>,
): ScopedRule {
  const texts = loadedTexts.map(({ path, text }) => ({
    path,
    text,
    hash: hash(text),
  }));
  return {
    ...rule,
    texts,
    hash: hash(
      JSON.stringify({
        id: rule.id,
        scope: rule.scope,
        intents: rule.intents,
        critical: rule.critical,
        texts,
      }),
    ),
  };
}

export function formatRules(rules: readonly ScopedRule[]): string {
  return rules
    .flatMap((rule) => [
      `### Scoped instruction: ${rule.id} [${rule.hash}]`,
      ...rule.texts.flatMap((file) => [
        `--- ${file.path} [${file.hash}] ---`,
        file.text,
      ]),
    ])
    .join('\n\n');
}
