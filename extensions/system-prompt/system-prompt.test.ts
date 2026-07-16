import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateAssistantUsage,
  buildSystemPrompt,
  discoverAncestorSkillDefinitions,
  estimateSize,
  formatPromptInfo,
  summarizeContextMessages,
  todoStateVersion,
} from './index';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'prompt-info-'));
  temporaryDirectories.push(path);
  return path;
}

function skill(name: string, filePath: string, disabled = false) {
  return {
    name,
    description: `${name} description`,
    filePath,
    baseDir: join(filePath, '..'),
    sourceInfo: {
      path: filePath,
      source: 'local',
      scope: 'project' as const,
      origin: 'top-level' as const,
      baseDir: join(filePath, '..'),
    },
    disableModelInvocation: disabled,
  };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe('prompt diagnostics helpers', () => {
  it('estimates tokens without retaining content', () => {
    expect(estimateSize('12345')).toEqual({ characters: 5, tokens: 2 });
  });

  it('summarizes retained results and hashes todo replay without exposing it', () => {
    const diagnostics = summarizeContextMessages(
      [
        {
          role: 'toolResult',
          toolName: 'read',
          content: [{ type: 'text', text: 'secret result' }],
        },
        {
          role: 'custom',
          customType: 'lean-todo-replay',
          content: 'private todo state',
        },
      ],
      3,
    );

    expect(diagnostics).toMatchObject({
      calls: 3,
      messages: 2,
      retainedToolResults: { count: 1, characters: 13, tokens: 4 },
      todoReplay: { count: 1, characters: 18, tokens: 5 },
    });
    expect(diagnostics.todoReplay.hash).toMatch(/^[a-f0-9]{12}$/);
    expect(JSON.stringify(diagnostics)).not.toContain('private todo');
  });

  it('recognizes immutable todo v2 snapshots as replay context', () => {
    const diagnostics = summarizeContextMessages([
      {
        role: 'custom',
        customType: 'lean-todo-replay-v2',
        content: 'turn snapshot',
      },
    ]);

    expect(diagnostics.todoReplay).toMatchObject({
      count: 1,
      characters: 13,
      tokens: 4,
    });
  });

  it('aggregates assistant provider usage and peak context', () => {
    const usage = (input: number, totalTokens: number) => ({
      input,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    expect(
      aggregateAssistantUsage([
        { role: 'user' },
        { role: 'assistant', usage: usage(10, 19) },
        { role: 'assistant', usage: usage(20, 29) },
      ]),
    ).toEqual({
      turns: 2,
      input: 30,
      output: 4,
      cacheRead: 6,
      cacheWrite: 8,
      peakContext: 29,
    });
  });

  it('observes the latest persisted todo state schema version', () => {
    expect(
      todoStateVersion([
        {
          type: 'custom',
          customType: 'lean-todo',
          data: { state: { version: 1 } },
        },
        {
          type: 'custom',
          customType: 'lean-todo',
          data: { state: { version: 2 } },
        },
      ]),
    ).toBe(2);
  });
});

describe('skills', () => {
  it('filters disableModelInvocation skills from the rebuilt prompt', () => {
    const prompt = buildSystemPrompt({
      cwd: '/work',
      selectedTools: ['read'],
      toolSnippets: { read: 'Read files' },
      skills: [
        skill('visible', '/work/visible/SKILL.md'),
        skill('hidden', '/work/hidden/SKILL.md', true),
      ],
    });
    expect(prompt).toContain('visible');
    expect(prompt).not.toContain('hidden');
  });

  it('discovers advisory duplicates in applicable ancestor skill directories', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, '.git'), 'gitdir fixture');
    const child = join(root, 'packages', 'app');
    const rootSkill = join(root, '.agents', 'skills', 'root-copy');
    const childSkill = join(child, '.agents', 'skills', 'child-copy');
    mkdirSync(rootSkill, { recursive: true });
    mkdirSync(childSkill, { recursive: true });
    writeFileSync(
      join(rootSkill, 'SKILL.md'),
      '---\nname: shared\ndescription: root\n---\n',
    );
    writeFileSync(
      join(childSkill, 'SKILL.md'),
      '---\nname: shared\ndescription: child\n---\n',
    );

    const definitions = discoverAncestorSkillDefinitions(child);
    expect(definitions.map(({ name }) => name)).toEqual(['shared', 'shared']);
    expect(definitions.map(({ filePath }) => filePath)).toEqual([
      join(childSkill, 'SKILL.md'),
      join(rootSkill, 'SKILL.md'),
    ]);
  });

  it('states Pi 0.80.7 limitations instead of claiming collision control', () => {
    const options = {
      cwd: '/work',
      selectedTools: ['read'],
      toolSnippets: { read: 'Read files' },
      skills: [skill('shared', '/work/.agents/skills/shared/SKILL.md')],
    };
    const info = formatPromptInfo(
      options,
      'effective',
      summarizeContextMessages([]),
      aggregateAssistantUsage([]),
      [
        {
          name: 'shared',
          filePath: '/work/.agents/skills/shared/SKILL.md',
          skillDir: '/work/.agents/skills',
        },
        {
          name: 'shared',
          filePath: '/work/sub/.agents/skills/shared/SKILL.md',
          skillDir: '/work/sub/.agents/skills',
        },
      ],
    );

    expect(info).toContain('Loaded skill winners: 1');
    expect(info).toContain('source=local, scope=project');
    expect(info).toContain(
      'advisory filesystem scan, not active collision diagnostics',
    );
    expect(info).toContain(
      'cannot control /skill resolution or add qualified /skill selection',
    );
    expect(info).toContain('Tool parameter schemas: unavailable');
    expect(info).not.toContain('qualified identity');
  });
});
