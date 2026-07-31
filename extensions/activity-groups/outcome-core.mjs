const MAX_CANONICAL_DEPTH = 20;
const MAX_CANONICAL_NODES = 1000;
const EDIT_TOOLS = new Set([
  'edit',
  'write',
  'multi_edit',
  'apply_patch',
  'str_replace',
]);

function canonicalize(value, state, depth = 0) {
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
  let result;
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
      const entries = Object.keys(value)
        .sort()
        .map((key) => {
          const item = canonicalize(value[key], state, depth + 1);
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

function signatureOf(name, args) {
  const value = canonicalize(args, { nodes: 0, ancestors: new Set() });
  return value === undefined ? undefined : `${JSON.stringify(name)}:${value}`;
}

function recordArg(args, key) {
  if (!args || typeof args !== 'object' || !(key in args)) return undefined;
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function baseName(name) {
  return (
    String(name ?? '')
      .split('.')
      .at(-1) ?? ''
  );
}

function pathTarget(value) {
  const normalized = value.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.split('/').at(-1) ?? normalized;
}

function retryIdentitiesOf(name, args) {
  const identities = new Set();
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
  const commandSegments = command
    .split(/&&|\|\||[;\n]/)
    .map((segment) => segment.trim());
  let runnerSegment;
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
  const interpreter = body.match(
    /(?:^|[;&|]\s*)(python(?:3(?:\.\d+)?)?|node|ruby|perl)\s+(?:-|<<)/i,
  )?.[1];
  if (interpreter)
    identities.add(
      `script:${area}:${interpreter.toLowerCase().replace(/\d+(?:\.\d+)?$/, '')}`,
    );
  const validationKinds = [
    ['lint', /\b(?:lint|eslint|ruff|clippy|biome)\b/i],
    ['test', /\b(?:test|tests|pytest|vitest|jest)\b/i],
    ['typecheck', /\b(?:typecheck|tsc|mypy)\b/i],
    ['format', /\b(?:format|prettier)\b/i],
  ];
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
    if (packageCheck || foundKinds.length >= 2)
      identities.add(`validate:${validationArea}:suite`);
  }
  return identities;
}

function intersects(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

/** Retry-aware aggregate outcome shared by activity rendering and session metrics. */
export function hasUnresolvedToolFailure(items) {
  const failed = new Map();
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

/** Keep command-family detection in one place for offline validation facets. */
export function validationKindsOf(name, args) {
  if (baseName(name) !== 'bash') return [];
  const command = recordArg(args, 'command') ?? '';
  const heredoc = command.search(/<<-?\s*['"]?[A-Za-z_]\w*['"]?/);
  const body = (
    heredoc >= 0 ? command.slice(0, heredoc) : command
  ).toLowerCase();
  const kinds = new Set();
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?check\b/.test(body))
    kinds.add('check');
  if (/\b(?:lint|eslint|ruff|clippy|biome)\b/.test(body)) kinds.add('lint');
  if (/\b(?:test|tests|pytest|vitest|jest)\b/.test(body)) kinds.add('test');
  if (/\b(?:typecheck|tsc|mypy)\b/.test(body)) kinds.add('typecheck');
  if (/\b(?:format|prettier)\b/.test(body)) kinds.add('format');
  return [...kinds];
}
