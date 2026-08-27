import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  installMidturnCompactionShim,
  MIDTURN_CONTINUE_CUSTOM_TYPE,
  type MidturnCompactionRuntime,
} from './runtime.js';

const SUPPORTED_PI_VERSION = '0.84.1';
const PACKAGE_NAME = '@earendil-works/pi-coding-agent';

async function findPackageRoot(startPath: string): Promise<string | undefined> {
  let directory = path.dirname(
    await realpath(startPath).catch(() => startPath),
  );
  for (;;) {
    const packageJsonPath = path.join(directory, 'package.json');
    try {
      const packageJson = JSON.parse(
        await readFile(packageJsonPath, 'utf8'),
      ) as { name?: string };
      if (packageJson.name === PACKAGE_NAME) return directory;
    } catch {
      // Keep walking toward the filesystem root.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function resolveRunningPackageRoot(): Promise<string> {
  const executable = process.argv[1];
  if (executable) {
    const executableRoot = await findPackageRoot(executable);
    if (executableRoot) return executableRoot;
  }

  const require = createRequire(path.join(__dirname, 'index.js'));
  const packageEntry = require.resolve(PACKAGE_NAME);
  const resolvedRoot = await findPackageRoot(packageEntry);
  if (resolvedRoot) return resolvedRoot;
  throw new Error(`Could not resolve the running ${PACKAGE_NAME} package.`);
}

async function loadRuntime(): Promise<MidturnCompactionRuntime> {
  const packageRoot = await resolveRunningPackageRoot();
  const packageJson = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as { version?: string };
  if (packageJson.version !== SUPPORTED_PI_VERSION) {
    throw new Error(
      `Unsupported Pi version ${String(packageJson.version)}; mid-run compaction expects ${SUPPORTED_PI_VERSION}.`,
    );
  }

  const [agentSessionModule, compactionModule] = await Promise.all([
    import(
      pathToFileURL(path.join(packageRoot, 'dist/core/agent-session.js')).href
    ),
    import(
      pathToFileURL(path.join(packageRoot, 'dist/core/compaction/index.js'))
        .href
    ),
  ]);
  if (typeof agentSessionModule.AgentSession !== 'function') {
    throw new Error('Running Pi package does not export AgentSession.');
  }
  if (typeof compactionModule.estimateContextTokens !== 'function') {
    throw new Error(
      'Running Pi package does not export estimateContextTokens.',
    );
  }
  if (typeof compactionModule.shouldCompact !== 'function') {
    throw new Error('Running Pi package does not export shouldCompact.');
  }
  return {
    AgentSession: agentSessionModule.AgentSession,
    estimateContextTokens: compactionModule.estimateContextTokens,
    shouldCompact: compactionModule.shouldCompact,
  } as MidturnCompactionRuntime;
}

export default async function midRunCompaction(
  pi: ExtensionAPI,
): Promise<void> {
  pi.on('context', (event) => {
    const messages = event.messages.filter(
      (message) =>
        message.role !== 'custom' ||
        message.customType !== MIDTURN_CONTINUE_CUSTOM_TYPE,
    );
    if (messages.length !== event.messages.length) return { messages };
  });
  installMidturnCompactionShim(await loadRuntime());
}
