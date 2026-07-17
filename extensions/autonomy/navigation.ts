import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_FILES = 60;

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  const result = await execFileAsync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT,
  });
  return result.stdout;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return run('git', ['-C', cwd, ...args], cwd);
}

export interface NavigationHint {
  path: string;
  line: number;
  text: string;
  sha256: string;
}

export interface NavigationResult {
  version: 2;
  disclaimer: string;
  repositoryRoot: string;
  snapshotId: string;
  head: string;
  dirty: boolean;
  changedPaths: string[];
  instructionFiles: Array<{ path: string; sha256: string }>;
  candidateFiles: string[];
  likelyTests: string[];
  packageScripts: string[];
  matches: string[];
  symbolHints: NavigationHint[];
  importHints: NavigationHint[];
  changedNeighborhoods: Array<{
    changedPath: string;
    nearbyFiles: string[];
  }>;
  workspaceFacts?: {
    repositoryName: string;
    defaultBranch?: string;
    verificationCommands: string[];
    configPath: string;
    configSha256: string;
  };
  liveEvidence: Array<{
    path: string;
    sha256: string;
    reasons: string[];
  }>;
  freshness: {
    head: string;
    tree: string;
    worktreeSha256: string;
    instructionsSha256: string;
    mgConfigSha256?: string;
  };
  verificationRequired: true;
  generatedAt: string;
}

function hashFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function parseChanged(status: string): string[] {
  const paths: string[] = [];
  const entries = status.split('\0').filter(Boolean);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const changedPath = entry.slice(3);
    if (changedPath) paths.push(changedPath);
    if (code.includes('R') || code.includes('C')) index++;
  }
  return [...new Set(paths)].sort();
}

async function hashChangedPath(
  root: string,
  relative: string,
): Promise<string> {
  const target = path.join(root, relative);
  if (!existsSync(target)) return 'deleted';
  const stat = lstatSync(target);
  if (stat.isSymbolicLink())
    return createHash('sha256')
      .update('symlink\0')
      .update(readlinkSync(target))
      .digest('hex');
  if (!stat.isFile()) return `mode:${stat.mode}:size:${stat.size}`;
  const hash = createHash('sha256').update(`mode:${stat.mode}\0`);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function workingTreeDigest(
  root: string,
  changedPaths: string[],
): Promise<string> {
  if (changedPaths.length > 5000)
    throw new Error('Navigation refuses more than 5000 changed paths');
  const hash = createHash('sha256');
  for (const changedPath of changedPaths)
    hash
      .update(changedPath)
      .update('\0')
      .update(await hashChangedPath(root, changedPath))
      .update('\0');
  return hash.digest('hex');
}

async function instructionFiles(root: string): Promise<
  Array<{
    path: string;
    sha256: string;
  }>
> {
  const files = (
    await run(
      'find',
      [
        '.',
        '-name',
        '.git',
        '-prune',
        '-o',
        '-name',
        'node_modules',
        '-prune',
        '-o',
        '-name',
        'AGENTS.md',
        '-type',
        'f',
        '-print',
      ],
      root,
    )
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 100)
    .sort();
  return files.map((relative) => ({
    path: relative.replace(/^\.\//, ''),
    sha256: hashFile(path.join(root, relative)),
  }));
}

function packageScripts(root: string): string[] {
  const file = path.join(root, 'package.json');
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    return Object.keys(parsed.scripts ?? {}).sort();
  } catch {
    return [];
  }
}

function likelyTests(files: string[], changed: string[]): string[] {
  const candidates = files.filter((file) =>
    /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(
      file,
    ),
  );
  if (changed.length === 0) return candidates.slice(0, 20);
  const stems = new Set(
    changed.map((file) =>
      path
        .basename(file)
        .replace(/\.[^.]+$/, '')
        .toLowerCase(),
    ),
  );
  return candidates
    .filter((file) => {
      const lower = file.toLowerCase();
      return [...stems].some((stem) => lower.includes(stem));
    })
    .slice(0, 30);
}

function boundedHints(
  root: string,
  files: string[],
  pattern: RegExp,
  limit: number,
): NavigationHint[] {
  const hints: NavigationHint[] = [];
  for (const relative of files.slice(0, 500)) {
    if (hints.length >= limit) break;
    const target = path.join(root, relative);
    try {
      const content = readFileSync(target, 'utf8');
      const sha256 = createHash('sha256').update(content).digest('hex');
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        if (!pattern.test(line)) continue;
        pattern.lastIndex = 0;
        hints.push({
          path: relative,
          line: index + 1,
          text: line.trim().slice(0, 500),
          sha256,
        });
        if (hints.length >= limit) break;
      }
    } catch {
      // Binary, deleted, or unreadable candidates do not produce hints.
    }
  }
  return hints;
}

function changedNeighborhoods(
  files: string[],
  changed: string[],
): Array<{ changedPath: string; nearbyFiles: string[] }> {
  return changed.slice(0, 30).map((changedPath) => {
    const directory = path.dirname(changedPath);
    const stem = path.basename(changedPath).replace(/\.[^.]+$/, '');
    const nearbyFiles = files
      .filter(
        (file) =>
          file !== changedPath &&
          (path.dirname(file) === directory ||
            path.basename(file).includes(stem)),
      )
      .sort((left, right) => {
        const leftTest = /test|spec/i.test(left) ? 0 : 1;
        const rightTest = /test|spec/i.test(right) ? 0 : 1;
        return leftTest - rightTest || left.localeCompare(right);
      })
      .slice(0, 12);
    return { changedPath, nearbyFiles };
  });
}

function workspaceFacts(
  repositoryRoot: string,
): NavigationResult['workspaceFacts'] | undefined {
  let cursor = repositoryRoot;
  while (true) {
    const configPath = path.join(cursor, 'mg', 'mg.config.json');
    if (existsSync(configPath)) {
      try {
        const bytes = readFileSync(configPath);
        const config = JSON.parse(bytes.toString('utf8')) as {
          repos?: Array<{
            name?: unknown;
            path?: unknown;
            defaultBranch?: unknown;
            verification?: { commands?: unknown };
          }>;
        };
        const repository = config.repos?.find((candidate) => {
          if (typeof candidate.path !== 'string' || !existsSync(candidate.path))
            return false;
          return realpathSync(candidate.path) === repositoryRoot;
        });
        if (!repository || typeof repository.name !== 'string') return;
        return {
          repositoryName: repository.name,
          ...(typeof repository.defaultBranch === 'string'
            ? { defaultBranch: repository.defaultBranch }
            : {}),
          verificationCommands: Array.isArray(repository.verification?.commands)
            ? repository.verification.commands.filter(
                (item): item is string => typeof item === 'string',
              )
            : [],
          configPath,
          configSha256: createHash('sha256').update(bytes).digest('hex'),
        };
      } catch {
        return;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

export async function generateNavigation(options: {
  cwd: string;
  query?: string;
  _attempt?: number;
}): Promise<NavigationResult> {
  const rawRoot = (
    await git(options.cwd, ['rev-parse', '--show-toplevel'])
  ).trim();
  const repositoryRoot = realpathSync(rawRoot);
  const head = (await git(repositoryRoot, ['rev-parse', 'HEAD'])).trim();
  const tree = (await git(repositoryRoot, ['rev-parse', 'HEAD^{tree}'])).trim();
  const status = await git(repositoryRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  const changedPaths = parseChanged(status);
  const instructions = await instructionFiles(repositoryRoot);
  const files = (
    await run(
      'rg',
      ['--files', '-g', '!node_modules', '-g', '!.git'],
      repositoryRoot,
    )
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 5000);
  const query = options.query?.trim();
  let matches: string[] = [];
  let candidateFiles = (changedPaths.length > 0 ? changedPaths : files).slice(
    0,
    MAX_FILES,
  );
  if (query) {
    try {
      matches = (
        await run(
          'rg',
          [
            '-n',
            '-m',
            '3',
            '--fixed-strings',
            '--glob',
            '!node_modules/**',
            '--glob',
            '!.git/**',
            query,
            '.',
          ],
          repositoryRoot,
        )
      )
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.slice(0, 500))
        .slice(0, 100);
      candidateFiles = [
        ...new Set(
          matches
            .map((line) => line.split(':', 1)[0].replace(/^\.\//, ''))
            .filter(Boolean),
        ),
      ].slice(0, MAX_FILES);
    } catch {
      matches = [];
      candidateFiles = [];
    }
  }
  const contentDigest = await workingTreeDigest(repositoryRoot, changedPaths);
  const facts = workspaceFacts(repositoryRoot);
  const sourceFiles = candidateFiles.filter((file) =>
    /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt)$/i.test(file),
  );
  const symbolHints = boundedHints(
    repositoryRoot,
    sourceFiles,
    /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|def|struct|enum)\s+[A-Za-z_$][\w$]*/,
    80,
  );
  const importHints = boundedHints(
    repositoryRoot,
    sourceFiles,
    /^\s*(?:import\b|export\s+.+\s+from\b|from\s+\S+\s+import\b|require\s*\()/,
    80,
  );
  const neighborhoods = changedNeighborhoods(files, changedPaths);
  const instructionDigest = createHash('sha256')
    .update(JSON.stringify(instructions))
    .digest('hex');
  const stateHash = createHash('sha256')
    .update(head)
    .update('\0')
    .update(status)
    .update('\0')
    .update(contentDigest)
    .update('\0')
    .update(JSON.stringify(instructions))
    .update('\0')
    .update(facts?.configSha256 ?? '')
    .digest('hex');
  const endHead = (await git(repositoryRoot, ['rev-parse', 'HEAD'])).trim();
  const endStatus = await git(repositoryRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  const endChanged = parseChanged(endStatus);
  const endContentDigest = await workingTreeDigest(repositoryRoot, endChanged);
  const endInstructions = await instructionFiles(repositoryRoot);
  const endFacts = workspaceFacts(repositoryRoot);
  const stable =
    head === endHead &&
    status === endStatus &&
    contentDigest === endContentDigest &&
    JSON.stringify(instructions) === JSON.stringify(endInstructions) &&
    facts?.configSha256 === endFacts?.configSha256;
  if (!stable) {
    if ((options._attempt ?? 0) < 1)
      return generateNavigation({ ...options, _attempt: 1 });
    throw new Error('Repository changed during navigation generation');
  }
  const evidenceReasons = new Map<string, Set<string>>();
  const addEvidence = (file: string, reason: string) => {
    const reasons = evidenceReasons.get(file) ?? new Set<string>();
    reasons.add(reason);
    evidenceReasons.set(file, reasons);
  };
  for (const file of changedPaths) addEvidence(file, 'changed');
  for (const file of candidateFiles) addEvidence(file, 'match');
  for (const hint of symbolHints) addEvidence(hint.path, 'symbol');
  for (const hint of importHints) addEvidence(hint.path, 'import');
  for (const file of likelyTests(files, changedPaths))
    addEvidence(file, 'test');
  const liveEvidence = [...evidenceReasons]
    .slice(0, 100)
    .flatMap(([relative, reasons]) => {
      const target = path.join(repositoryRoot, relative);
      if (!existsSync(target) || !lstatSync(target).isFile()) return [];
      return [
        {
          path: relative,
          sha256: hashFile(target),
          reasons: [...reasons].sort(),
        },
      ];
    });
  return {
    version: 2,
    disclaimer:
      'Candidate locator only. Verify current code, applicable instructions, and tests before mutation or product/API decisions.',
    repositoryRoot,
    snapshotId: `nav-${stateHash.slice(0, 20)}`,
    head,
    dirty: status.length > 0,
    changedPaths,
    instructionFiles: instructions,
    candidateFiles,
    likelyTests: likelyTests(files, changedPaths),
    packageScripts: packageScripts(repositoryRoot),
    matches,
    symbolHints,
    importHints,
    changedNeighborhoods: neighborhoods,
    workspaceFacts: facts,
    liveEvidence,
    freshness: {
      head,
      tree,
      worktreeSha256: contentDigest,
      instructionsSha256: instructionDigest,
      ...(facts ? { mgConfigSha256: facts.configSha256 } : {}),
    },
    verificationRequired: true,
    generatedAt: new Date().toISOString(),
  };
}
