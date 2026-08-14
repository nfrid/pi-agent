import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export interface LoadedInstruction {
  path: string;
  content: string;
}

/** Load one explicitly named instruction file below the Pi agent directory. */
export function loadInstruction(
  agentRelativePath: string,
  agentDir = getAgentDir(),
): LoadedInstruction {
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

/** Load one explicitly named Markdown guideline file below the Pi agent directory. */
export function loadGuidelines(
  agentRelativePath: string,
  agentDir = getAgentDir(),
): string[] {
  const content = loadInstruction(agentRelativePath, agentDir).content;

  if (content.length === 0) {
    throw new Error(
      `Required agent guideline file is empty: ${agentRelativePath}`,
    );
  }

  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line, index) => {
    if (!line.startsWith('- ') || line.slice(2).trim().length === 0) {
      throw new Error(
        `Agent guideline must contain only non-empty '- ' bullet entries: ${agentRelativePath} (line ${index + 1})`,
      );
    }
    return line.slice(2).trim();
  });
}
