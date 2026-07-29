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

function recordArg(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== 'object' || !(key in args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function baseName(name: string): string {
  return name.split('.').at(-1) ?? name;
}

function pathTarget(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.split('/').at(-1) ?? normalized;
}

const EDIT_TOOLS = new Set([
  'edit',
  'write',
  'multi_edit',
  'apply_patch',
  'str_replace',
]);

/**
 * A deliberately narrow, coarser identity for calls whose arguments normally
 * change while they are being corrected. Exact signatures remain the default;
 * these identities cover the retry loops visible in real agent transcripts.
 */
function retryIdentitiesOf(name: string, args: unknown): Set<string> {
  const identities = new Set<string>();
  const tool = baseName(name);

  if (EDIT_TOOLS.has(tool)) {
    const path = recordArg(args, 'path') ?? recordArg(args, 'file_path');
    if (path) identities.add(`edit:${tool}:${path.replace(/\\/g, '/')}`);
    return identities;
  }

  if (tool !== 'bash') return identities;
  const command = recordArg(args, 'command');
  if (!command) return identities;

  const workdir = recordArg(args, 'workdir') ?? recordArg(args, 'cwd');
  const changedDirectories = [
    ...command.matchAll(/(?:^|[;&|]\s*)cd\s+([^\s;&|]+)/g),
  ];
  const lastCd = changedDirectories.at(-1)?.[1];
  const leadingCd = changedDirectories[0]?.[1];
  const area = pathTarget(workdir ?? lastCd ?? '.');
  const validationAreas = new Set(
    workdir
      ? [pathTarget(workdir)]
      : changedDirectories.length > 0
        ? changedDirectories.map((match) => pathTarget(match[1] ?? '.'))
        : ['.'],
  );
  const body = leadingCd
    ? command.slice(command.indexOf(leadingCd) + leadingCd.length)
    : command;

  // A corrected setup prefix (`cd`, `source`, environment flags) commonly
  // leaves the actual package invocation unchanged. That invocation is a safe
  // identity even when the working directory was the thing being fixed.
  const commandSegments = command
    .split(/&&|\|\||[;\n]/)
    .map((segment) => segment.trim());
  let runnerSegment: string | undefined;
  for (let index = commandSegments.length - 1; index >= 0; index -= 1) {
    const segment = commandSegments[index];
    if (segment && /^(?:bun|npm|pnpm|yarn)\s+/.test(segment)) {
      runnerSegment = segment;
      break;
    }
  }
  if (runnerSegment) {
    const normalizedRunner = runnerSegment.replace(/\s+/g, ' ');
    const scriptTarget = normalizedRunner.match(
      /^(?:bun|node)\s+(?:run\s+)?([^\s]+\.(?:[cm]?[jt]sx?))\b/,
    )?.[1];
    identities.add(
      scriptTarget
        ? `command-script:${normalizedRunner}`
        : `command:${area}:${normalizedRunner}`,
    );
  }

  // Heredoc bodies necessarily change when a script is fixed; the interpreter
  // and working area are the stable expression of intent available to us.
  const interpreter = body.match(
    /(?:^|[;&|]\s*)(python(?:3(?:\.\d+)?)?|node|ruby|perl)\s+(?:-|<<)/i,
  )?.[1];
  if (interpreter)
    identities.add(
      `script:${area}:${interpreter.toLowerCase().replace(/\d+(?:\.\d+)?$/, '')}`,
    );

  // Validation retries often add a formatter or split one package script into
  // explicit checks. Keep lint and test distinct so an unrelated green test
  // cannot erase a red lint run.
  const validationKinds: [string, RegExp][] = [
    ['lint', /\b(?:lint|eslint|ruff|clippy|biome)\b/i],
    ['test', /\b(?:test|tests|pytest|vitest|jest)\b/i],
    ['typecheck', /\b(?:typecheck|tsc|mypy)\b/i],
    ['format', /\b(?:format|prettier)\b/i],
  ];
  // A heredoc's contents are source code, not shell invocations. Words such as
  // "test" inside it must not make the script look like a validation command.
  const validationBody = /<<-?\s*['"]?[A-Za-z_]\w*['"]?/.test(body)
    ? (body.split('\n')[0] ?? body)
    : body;
  const foundKinds = validationKinds
    .filter(([, pattern]) => pattern.test(validationBody))
    .map(([kind]) => kind);
  const packageCheck = /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?check\b/i.test(
    validationBody,
  );
  for (const validationArea of validationAreas) {
    for (const kind of foundKinds)
      identities.add(`validate:${validationArea}:${kind}`);
    if (packageCheck) identities.add(`validate:${validationArea}:check`);
    // In this repository `check` is the aggregate validation script. A later
    // explicit run covering multiple validation kinds is its corrected form.
    if (packageCheck || foundKinds.length >= 2)
      identities.add(`validate:${validationArea}:suite`);
  }

  return identities;
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

/**
 * Whether a sequence has a failed call whose intent has not been resolved by a
 * later successful call. Exact arguments identify ordinary retries; edits,
 * inline scripts and validation commands also carry a narrow intent identity
 * because correcting them necessarily changes their arguments. Input order is
 * transcript order, so a later failure reopens an intent after an earlier
 * success.
 */
export function hasUnresolvedToolFailure(
  items: readonly SequenceItem[],
): boolean {
  const failed = new Map<string, Set<string>>();
  let unkeyedFailure = false;
  for (const item of items) {
    if (item.type !== 'tool') continue;
    const signature = signatureOf(item.name, item.args);
    if (signature === undefined) {
      if (item.isError) unkeyedFailure = true;
      continue;
    }
    const identities = retryIdentitiesOf(item.name, item.args);
    if (item.isError) {
      failed.set(signature, identities);
      continue;
    }
    if (item.status !== 'complete') continue;
    for (const [failedSignature, failedIdentities] of failed)
      if (
        failedSignature === signature ||
        intersects(failedIdentities, identities)
      )
        failed.delete(failedSignature);
  }
  return unkeyedFailure || failed.size > 0;
}
