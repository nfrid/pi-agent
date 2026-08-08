import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceTarget } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  ComposerCommandService,
  composerCommandCatalogue,
} from './composer-command-service.js';

function workspace(canonicalPath: string): WorkspaceTarget {
  return {
    id: 'workspace-1',
    name: 'Workspace',
    path: canonicalPath,
    canonicalPath,
    source: 'directory',
    active: true,
  };
}

describe('ComposerCommandService', () => {
  it('discovers trusted project prompts and skills without extension commands', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'pi-dashboard-composer-'),
    );
    const agentDir = path.join(root, 'agent');
    const project = path.join(root, 'project');
    await mkdir(path.join(agentDir, 'prompts'), { recursive: true });
    await mkdir(path.join(project, '.pi', 'prompts'), { recursive: true });
    await mkdir(path.join(project, '.pi', 'skills', 'demo'), {
      recursive: true,
    });
    await writeFile(
      path.join(project, '.pi', 'prompts', 'review.md'),
      '---\ndescription: Review code\nargument-hint: <path>\n---\nReview $1',
    );
    await writeFile(
      path.join(project, '.pi', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Demo skill\n---\nUse this skill.',
    );
    try {
      const result = await new ComposerCommandService(agentDir).forWorkspace(
        'workspace-1',
        [workspace(project)],
      );
      expect(result.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'review',
            source: 'prompt',
            argumentHint: '<path>',
          }),
          expect.objectContaining({
            name: 'skill:demo',
            source: 'skill',
            description: 'Demo skill',
          }),
          expect.objectContaining({ name: 'compact', source: 'builtin' }),
        ]),
      );
      expect(result.commands.map(({ name }) => name)).not.toContain('secret');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unknown workspace ids before resource loading', async () => {
    await expect(
      new ComposerCommandService('/tmp/unused').forWorkspace('missing', []),
    ).rejects.toMatchObject({ code: 'unknown-workspace' });
  });

  it('bounds and deduplicates projected catalogue entries', () => {
    const result = composerCommandCatalogue(
      Array.from({ length: 300 }, (_, index) => ({
        name: `prompt-${index}`,
        description: 'x'.repeat(2_000),
        argumentHint: 'y'.repeat(500),
        content: '',
        sourceInfo: {} as never,
        filePath: `/tmp/${index}.md`,
      })),
      [],
    );
    expect(result.commands).toHaveLength(256);
    expect(result.commands.at(-1)?.description).toHaveLength(1_024);
    expect(result.commands.at(-1)?.argumentHint).toHaveLength(256);
  });
});
