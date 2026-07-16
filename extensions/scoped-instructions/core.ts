import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MANIFEST_RELATIVE_PATH = '.pi/scoped-instructions.json';
export const MANIFEST_VERSION = 1;

/** Hard input/prompt limits. Byte limits are measured as UTF-8/on-disk bytes. */
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_RULE_COUNT = 64;
export const MAX_FILES_PER_RULE = 8;
export const MAX_INSTRUCTION_BYTES = 64 * 1024;
export const MAX_TOTAL_INSTRUCTION_BYTES = 256 * 1024;
export const MAX_TOTAL_CRITICAL_EAGER_BYTES = 128 * 1024;

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

export interface LoadedManifest {
  repositoryRoot: string;
  manifestPath: string;
  rules: ScopedRule[];
  error?: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === '' ||
    (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
  );
}

function safeRelative(value: unknown, kind: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`${kind} must be a non-empty portable relative path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${kind} contains an empty, dot, or traversal segment`);
  }
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
  ) {
    throw new Error(`${kind} must contain exactly: ${expected.join(', ')}`);
  }
}

export function findRepositoryRoot(cwd: string): string | undefined {
  let cursor = realpathSync(resolve(cwd));
  while (true) {
    if (existsSync(join(cursor, '.git'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

/** Load and strictly validate the repository manifest as one atomic unit. */
export function loadManifest(cwd: string): LoadedManifest | undefined {
  const repositoryRoot = findRepositoryRoot(cwd);
  if (!repositoryRoot) return undefined;
  const manifestPath = join(repositoryRoot, MANIFEST_RELATIVE_PATH);
  if (!existsSync(manifestPath))
    return { repositoryRoot, manifestPath, rules: [] };

  try {
    const canonicalManifest = realpathSync(manifestPath);
    if (
      !isInside(repositoryRoot, canonicalManifest) ||
      !lstatSync(canonicalManifest).isFile()
    ) {
      throw new Error('manifest is not a regular file inside the repository');
    }
    const manifestStat = lstatSync(canonicalManifest);
    if (manifestStat.size > MAX_MANIFEST_BYTES)
      throw new Error(
        `manifest exceeds ${MAX_MANIFEST_BYTES} byte limit (${manifestStat.size} bytes)`,
      );
    const manifestBytes = readFileSync(canonicalManifest);
    if (manifestBytes.byteLength > MAX_MANIFEST_BYTES)
      throw new Error(
        `manifest exceeds ${MAX_MANIFEST_BYTES} byte limit (${manifestBytes.byteLength} bytes)`,
      );
    const parsed: unknown = JSON.parse(manifestBytes.toString('utf8'));
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

    const ids = new Set<string>();
    let totalInstructionBytes = 0;
    let totalCriticalInstructionBytes = 0;
    const rules = object.rules.map((candidate, index): ScopedRule => {
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
        rule.intents.some(
          (intent) => intent !== 'edit' && intent !== 'write',
        ) ||
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
      const files = rule.instructionFiles.map((file) =>
        safeRelative(file, `rule ${rule.id} instruction file`),
      );
      if (new Set(files).size !== files.length)
        throw new Error(`rule ${rule.id} has duplicate instruction files`);
      if (typeof rule.critical !== 'boolean')
        throw new Error(`rule ${rule.id} critical must be boolean`);
      const texts = files.map((path) => {
        const canonical = realpathSync(join(repositoryRoot, path));
        if (!isInside(repositoryRoot, canonical))
          throw new Error(
            `rule ${rule.id} instruction escapes the repository or is not a file: ${path}`,
          );
        const instructionStat = lstatSync(canonical);
        if (!instructionStat.isFile())
          throw new Error(
            `rule ${rule.id} instruction escapes the repository or is not a file: ${path}`,
          );
        if (instructionStat.size > MAX_INSTRUCTION_BYTES)
          throw new Error(
            `rule ${rule.id} instruction ${path} exceeds ${MAX_INSTRUCTION_BYTES} byte limit (${instructionStat.size} bytes)`,
          );
        if (
          totalInstructionBytes + instructionStat.size >
          MAX_TOTAL_INSTRUCTION_BYTES
        )
          throw new Error(
            `instructions exceed ${MAX_TOTAL_INSTRUCTION_BYTES} total byte limit`,
          );
        if (
          rule.critical &&
          totalCriticalInstructionBytes + instructionStat.size >
            MAX_TOTAL_CRITICAL_EAGER_BYTES
        )
          throw new Error(
            `critical eager instructions exceed ${MAX_TOTAL_CRITICAL_EAGER_BYTES} total byte limit`,
          );
        const bytes = readFileSync(canonical);
        if (bytes.byteLength > MAX_INSTRUCTION_BYTES)
          throw new Error(
            `rule ${rule.id} instruction ${path} exceeds ${MAX_INSTRUCTION_BYTES} byte limit (${bytes.byteLength} bytes)`,
          );
        totalInstructionBytes += bytes.byteLength;
        if (totalInstructionBytes > MAX_TOTAL_INSTRUCTION_BYTES)
          throw new Error(
            `instructions exceed ${MAX_TOTAL_INSTRUCTION_BYTES} total byte limit`,
          );
        if (rule.critical) {
          totalCriticalInstructionBytes += bytes.byteLength;
          if (totalCriticalInstructionBytes > MAX_TOTAL_CRITICAL_EAGER_BYTES)
            throw new Error(
              `critical eager instructions exceed ${MAX_TOTAL_CRITICAL_EAGER_BYTES} total byte limit`,
            );
        }
        const text = bytes.toString('utf8');
        return { path, text, hash: hash(text) };
      });
      const intents = rule.intents as MutationIntent[];
      return {
        id: rule.id,
        scope,
        intents,
        instructionFiles: files,
        critical: rule.critical,
        texts,
        hash: hash(
          JSON.stringify({
            id: rule.id,
            scope,
            intents,
            critical: rule.critical,
            texts,
          }),
        ),
      };
    });
    const criticalEagerBytes = Buffer.byteLength(
      formatRules(rules.filter((rule) => rule.critical)),
      'utf8',
    );
    if (criticalEagerBytes > MAX_TOTAL_CRITICAL_EAGER_BYTES)
      throw new Error(
        `formatted critical eager prompt exceeds ${MAX_TOTAL_CRITICAL_EAGER_BYTES} total byte limit (${criticalEagerBytes} bytes)`,
      );
    return { repositoryRoot, manifestPath, rules };
  } catch (error) {
    return {
      repositoryRoot,
      manifestPath,
      rules: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Resolve existing targets and non-existing write targets through their real parent. */
export function canonicalTarget(
  repositoryRoot: string,
  cwd: string,
  target: string,
): { absolute: string; relative: string } {
  if (
    typeof target !== 'string' ||
    target.length === 0 ||
    target.includes('\0')
  )
    throw new Error('tool target path is missing or invalid');
  const requested = resolve(cwd, target);
  let ancestor = requested;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('target has no existing ancestor');
    missing.unshift(
      ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)),
    );
    ancestor = parent;
  }
  const absolute = join(realpathSync(ancestor), ...missing);
  if (!isInside(repositoryRoot, absolute))
    throw new Error(
      'target escapes the repository (including through a symlink)',
    );
  return {
    absolute,
    relative: relative(repositoryRoot, absolute).split(sep).join('/'),
  };
}

export function applicableRules(
  manifest: LoadedManifest,
  target: string,
  intent: MutationIntent,
): ScopedRule[] {
  return manifest.rules.filter((rule) => {
    const inScope =
      rule.scope === '.' ||
      target === rule.scope ||
      target.startsWith(`${rule.scope}/`);
    return inScope && rule.intents.includes(intent);
  });
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
