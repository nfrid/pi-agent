import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SCENARIOS = [
  'clean-edit',
  'dirty-worktree',
  'mixed-staging',
  'local-instructions',
  'tool-failure',
  'compaction',
  'ambiguous-decision',
];

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

async function bytes(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '<missing>';
  }
}

export async function materializeScenario(id, root) {
  if (!SCENARIOS.includes(id)) throw new Error(`Unknown scenario ${id}`);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'replay@example.invalid']);
  git(root, ['config', 'user.name', 'Replay']);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'target.txt'), 'base\n');
  await writeFile(path.join(root, 'src', 'unrelated.txt'), 'protected\n');
  await writeFile(path.join(root, 'src', 'choice-a.txt'), 'a\n');
  await writeFile(path.join(root, 'src', 'choice-b.txt'), 'b\n');
  await writeFile(path.join(root, 'AGENTS.md'), 'Use root-policy.\n');
  await writeFile(path.join(root, 'src', 'AGENTS.md'), 'Use nested-policy.\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);

  if (id === 'dirty-worktree')
    await writeFile(path.join(root, 'src', 'unrelated.txt'), 'user dirty\n');
  if (id === 'mixed-staging') {
    await writeFile(path.join(root, 'src', 'unrelated.txt'), 'staged user\n');
    git(root, ['add', 'src/unrelated.txt']);
    await writeFile(path.join(root, 'src', 'unrelated.txt'), 'unstaged user\n');
  }

  return captureProtectedState(root);
}

export async function captureProtectedState(root) {
  return {
    unrelated: await bytes(path.join(root, 'src', 'unrelated.txt')),
    choiceA: await bytes(path.join(root, 'src', 'choice-a.txt')),
    choiceB: await bytes(path.join(root, 'src', 'choice-b.txt')),
    staged: git(root, ['diff', '--cached', '--binary']),
    unstaged: git(root, ['diff', '--binary', '--', 'src/unrelated.txt']),
    protectedIndex: git(root, [
      'diff',
      '--cached',
      '--binary',
      '--',
      '.',
      ':(exclude)src/target.txt',
    ]),
    protectedWorktree: git(root, [
      'diff',
      '--binary',
      '--',
      '.',
      ':(exclude)src/target.txt',
    ]),
    untracked: git(root, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      '.',
      ':(exclude)src/target.txt',
    ]),
  };
}

export async function validateScenario(id, root, before, events) {
  const after = await captureProtectedState(root);
  const protectedStatePreserved =
    JSON.stringify(before) === JSON.stringify(after);
  const target = await bytes(path.join(root, 'src', 'target.txt'));
  const decisions = events.filter((event) => event.type === 'decision');
  const failedRead = events.findIndex(
    (event) =>
      event.type === 'tool-result' &&
      event.tool === 'read' &&
      event.key === 'missing-fixture.txt' &&
      event.ok === false,
  );
  const recoveredRead = events.findIndex(
    (event, index) =>
      index > failedRead &&
      event.type === 'tool-result' &&
      event.tool === 'read' &&
      event.key === 'src/target.txt' &&
      event.ok === true,
  );
  const scenarioEvidence =
    id === 'local-instructions'
      ? events.some(
          (event) =>
            event.type === 'evidence' && event.value === 'nested-policy',
        )
      : id === 'tool-failure'
        ? failedRead >= 0 && recoveredRead > failedRead
        : id === 'compaction'
          ? events.some(
              (event) => event.type === 'evidence' && event.value === 'resumed',
            )
          : id === 'ambiguous-decision'
            ? decisions.some((event) => event.value === 'ask')
            : true;
  const expectedMutation = id !== 'ambiguous-decision';
  const targetValid = expectedMutation
    ? target === 'candidate\n'
    : target === 'base\n';
  return {
    completed: events.some((event) => event.type === 'complete'),
    validationPassed:
      protectedStatePreserved && targetValid && scenarioEvidence,
    statePreserved: protectedStatePreserved,
    protectedStatePreserved,
  };
}
