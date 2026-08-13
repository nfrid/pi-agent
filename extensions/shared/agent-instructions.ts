import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export interface LoadedAgentInstruction {
  path: string;
  content: string;
}

/** Load one explicitly named Markdown file below the Pi agent directory. */
export function loadAgentInstruction(
  agentRelativePath: string,
  agentDir = getAgentDir(),
): LoadedAgentInstruction {
  if (isAbsolute(agentRelativePath)) {
    throw new Error(
      `Agent instruction path must be relative to the agent directory: ${agentRelativePath}`,
    );
  }

  const agentRoot = resolve(agentDir);
  const sourcePath = resolve(agentRoot, agentRelativePath);
  const fromAgentRoot = relative(agentRoot, sourcePath);
  if (
    fromAgentRoot === '..' ||
    fromAgentRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromAgentRoot)
  ) {
    throw new Error(
      `Agent instruction path must stay below the agent directory: ${agentRelativePath}`,
    );
  }

  try {
    return {
      path: sourcePath,
      content: readFileSync(sourcePath, 'utf8').trim(),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Required agent instruction could not be loaded: ${agentRelativePath} (${sourcePath}): ${reason}`,
      { cause: error },
    );
  }
}
