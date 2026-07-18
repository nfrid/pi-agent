import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface SkillDefinition {
  name: string;
  filePath: string;
  skillDir: string;
}

function parseSkillName(filePath: string): string {
  try {
    const content = readFileSync(filePath, 'utf8');
    const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
    const configured = frontmatter
      ?.split(/\r?\n/)
      .find((line) => /^name\s*:/.test(line))
      ?.replace(/^name\s*:\s*/, '')
      .trim()
      .replace(/^['"]|['"]$/g, '');
    return configured || dirname(filePath).split(/[\\/]/).pop() || filePath;
  } catch {
    return dirname(filePath).split(/[\\/]/).pop() || filePath;
  }
}

function collectSkillFiles(dir: string, includeRootFiles = true): string[] {
  if (!existsSync(dir)) return [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md'))
      return [join(dir, 'SKILL.md')];
    const result: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory())
        result.push(...collectSkillFiles(entryPath, false));
      else if (includeRootFiles && entry.isFile() && entry.name.endsWith('.md'))
        result.push(entryPath);
      else if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(entryPath);
          if (stats.isDirectory())
            result.push(...collectSkillFiles(entryPath, false));
          else if (
            includeRootFiles &&
            stats.isFile() &&
            entryPath.endsWith('.md')
          )
            result.push(entryPath);
        } catch {}
      }
    }
    return result;
  } catch {
    return [];
  }
}

export function discoverAncestorSkillDefinitions(
  cwd: string,
): SkillDefinition[] {
  const start = resolve(cwd);
  let gitRoot: string | undefined;
  let cursor = start;
  while (true) {
    if (existsSync(join(cursor, '.git'))) {
      gitRoot = cursor;
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const definitions: SkillDefinition[] = [];
  cursor = start;
  while (true) {
    const skillDir = join(cursor, '.agents', 'skills');
    for (const filePath of collectSkillFiles(skillDir)) {
      definitions.push({
        name: parseSkillName(filePath),
        filePath,
        skillDir,
      });
    }
    if (cursor === gitRoot) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return definitions;
}

export function workspaceSkillPath(cwd: string): string | undefined {
  let cursor = resolve(cwd);
  while (true) {
    const skills = join(cursor, '.agents', 'skills');
    if (
      existsSync(skills) &&
      existsSync(join(cursor, 'AGENTS.md')) &&
      existsSync(join(cursor, 'mg'))
    )
      return skills;
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
