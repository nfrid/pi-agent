import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const patchPath = path.join(
  repoRoot,
  'patches',
  '@earendil-works__pi-coding-agent@0.84.1.patch',
);
const piCommand = process.env.PI_EXECUTABLE?.trim() || 'pi';
const piExecutable = realpathSync(
  piCommand.includes(path.sep)
    ? piCommand
    : execFileSync('which', [piCommand], { encoding: 'utf8' }).trim(),
);
const packageRoot = path.dirname(path.dirname(piExecutable));
const packageJson = JSON.parse(
  readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
);
if (packageJson.name !== '@earendil-works/pi-coding-agent')
  throw new Error(`Unexpected Pi package at ${packageRoot}.`);
if (packageJson.version !== '0.84.1')
  throw new Error(
    `Compaction API patch targets Pi 0.84.1, found ${packageJson.version}. Run pnpm run pi:sdk-sync after updating the patch.`,
  );

const targets = [
  [
    'dist/core/agent-session.js',
    'abortCompaction: () => this.abortCompaction()',
  ],
  ['dist/core/extensions/runner.js', 'abortCompactionFn = () => { }'],
  ['dist/core/extensions/types.d.ts', 'abortCompaction(): void'],
];
const isPatched = () =>
  targets.every(([file, marker]) =>
    readFileSync(path.join(packageRoot, file), 'utf8').includes(marker),
  );

if (!isPatched()) {
  const result = spawnSync(
    'patch',
    ['--batch', '--forward', '-p1', '-i', patchPath],
    {
      cwd: packageRoot,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0)
    throw new Error(
      `Could not patch installed Pi at ${packageRoot}.\n${result.stdout}${result.stderr}`,
    );
}
if (!isPatched()) throw new Error('Installed Pi patch did not verify.');
console.log(
  `Patched Pi ${packageJson.version} compaction API at ${packageRoot}`,
);
