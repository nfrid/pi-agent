import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  buildRule,
  formatRules,
  parseManifestEnvelope,
  parseManifestRule,
  type ScopedRule,
} from './manifest';

export {
  formatRules,
  MANIFEST_VERSION,
  MAX_FILES_PER_RULE,
  MAX_RULE_COUNT,
  type MutationIntent,
  type ScopedRule,
} from './manifest';

import type { MutationIntent } from './manifest';

export const MANIFEST_RELATIVE_PATH = '.pi/scoped-instructions.json';
/** Hard input/prompt limits. Byte limits are measured as UTF-8/on-disk bytes. */
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_INSTRUCTION_BYTES = 64 * 1024;
export const MAX_TOTAL_INSTRUCTION_BYTES = 256 * 1024;
export const MAX_TOTAL_CRITICAL_EAGER_BYTES = 128 * 1024;

export interface LoadedManifest {
  repositoryRoot: string;
  manifestPath: string;
  rules: ScopedRule[];
  error?: string;
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === '' ||
    (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
  );
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

/** Securely load a strictly validated repository manifest as one atomic unit. */
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
    )
      throw new Error('manifest is not a regular file inside the repository');
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
    const candidates = parseManifestEnvelope(manifestBytes.toString('utf8'));
    const ids = new Set<string>();
    let totalInstructionBytes = 0;
    let totalCriticalInstructionBytes = 0;
    const rules = candidates.map((candidate, index) => {
      const rule = parseManifestRule(candidate, index, ids);
      const texts = rule.instructionFiles.map((path) => {
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
        return { path, text: bytes.toString('utf8') };
      });
      return buildRule(rule, texts);
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
