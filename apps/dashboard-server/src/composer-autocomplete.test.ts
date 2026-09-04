import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  composerCommandCatalogue,
  composerFileSuggestions,
  expandComposerTitleInput,
} from './composer-autocomplete.js';

const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-composer-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe('composer autocomplete service', () => {
  it('discovers builtins, project prompts, and project skills without a runtime', async () => {
    const cwd = await temporaryDirectory();
    await mkdir(path.join(cwd, '.pi', 'prompts'), { recursive: true });
    await writeFile(
      path.join(cwd, '.pi', 'prompts', 'review.md'),
      '---\ndescription: Review this checkout\n---\nReview $ARGUMENTS',
    );
    await mkdir(path.join(cwd, '.agents', 'skills', 'demo'), {
      recursive: true,
    });
    await writeFile(
      path.join(cwd, '.agents', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Demonstrate draft discovery\n---\nDo the demo.',
    );

    const result = await composerCommandCatalogue(cwd);

    expect(result.commands).toContainEqual(
      expect.objectContaining({ name: 'compact', source: 'builtin' }),
    );
    expect(result.commands).toContainEqual(
      expect.objectContaining({ name: 'review', source: 'prompt' }),
    );
    expect(result.commands).toContainEqual(
      expect.objectContaining({ name: 'skill:demo', source: 'skill' }),
    );
  });

  it('expands completed prompt and skill commands for automatic titles', async () => {
    const cwd = await temporaryDirectory();
    await mkdir(path.join(cwd, '.pi', 'prompts'), { recursive: true });
    await writeFile(
      path.join(cwd, '.pi', 'prompts', 'review.md'),
      `Review $1 with \${2:-care}.`,
    );
    await mkdir(path.join(cwd, '.agents', 'skills', 'demo'), {
      recursive: true,
    });
    const skillFile = path.join(cwd, '.agents', 'skills', 'demo', 'SKILL.md');
    await writeFile(
      skillFile,
      '---\nname: demo\ndescription: Demonstrate title expansion\n---\nDo the demo.',
    );

    await expect(
      expandComposerTitleInput(cwd, '/review "src/app.ts" '),
    ).resolves.toBe('Review src/app.ts with care.');
    const skillBlock = `<skill name="demo" location="${skillFile}">\nReferences are relative to ${path.join(cwd, '.agents', 'skills', 'demo')}.\n\nDo the demo.\n</skill>`;
    await expect(expandComposerTitleInput(cwd, '/skill:demo ')).resolves.toBe(
      skillBlock,
    );
    await expect(
      expandComposerTitleInput(cwd, 'Use $demo but keep `$demo`.'),
    ).resolves.toBe(`${skillBlock}\n\nUse demo but keep \`$demo\`.`);
    await expect(
      expandComposerTitleInput(cwd, '/unknown with $demo'),
    ).resolves.toBe(`${skillBlock}\n\n/unknown with demo`);
  });

  it('respects ignores for fuzzy search but enters ignored and parent paths explicitly', async () => {
    const parent = await temporaryDirectory();
    const cwd = path.join(parent, 'project');
    await mkdir(path.join(cwd, '.ignoredDir'), { recursive: true });
    await writeFile(path.join(cwd, '.gitignore'), '.ignoredDir/\n');
    await writeFile(path.join(cwd, 'visible.ts'), 'visible');
    await writeFile(path.join(cwd, '.ignoredDir', 'hidden.ts'), 'hidden');
    await writeFile(path.join(parent, 'sibling.ts'), 'sibling');

    await expect(composerFileSuggestions(cwd, 'hidden')).resolves.toEqual({
      suggestions: [],
    });
    await expect(
      composerFileSuggestions(cwd, '.ignoredDir/hi'),
    ).resolves.toEqual({
      suggestions: [
        {
          value: '.ignoredDir/hidden.ts',
          label: 'hidden.ts',
          directory: false,
        },
      ],
    });
    await expect(composerFileSuggestions(cwd, '../sib')).resolves.toEqual({
      suggestions: [
        {
          value: '../sibling.ts',
          label: 'sibling.ts',
          directory: false,
        },
      ],
    });
  });
});
