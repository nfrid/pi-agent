import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDelegateConfig } from '../delegate/config';
import {
  aggregateAssistantUsage,
  buildSystemPrompt,
  delegateToolBoundary,
  discoverAncestorSkillDefinitions,
  estimateSize,
  formatDelegateRoutingConfig,
  formatPromptInfo,
  summarizeContextMessages,
  todoStateVersion,
  workspaceSkillPath,
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
  it('blocks delegate tool paths and symlinks outside the checkout', () => {
    const parent = temporaryDirectory();
    const root = join(parent, 'repository');
    const outside = join(parent, 'outside.txt');
    mkdirSync(root);
    writeFileSync(join(root, 'inside.txt'), 'inside\n');
    writeFileSync(outside, 'outside\n');
    symlinkSync(outside, join(root, 'escape.txt'));
    expect(delegateToolBoundary('read', { path: 'inside.txt' }, root)).toBe(
      undefined,
    );
    expect(delegateToolBoundary('write', { path: 'new.txt' }, root)).toBe(
      undefined,
    );
    expect(
      delegateToolBoundary('read', { path: '../outside.txt' }, root),
    ).toMatch(/outside/);
    expect(delegateToolBoundary('read', { path: 'escape.txt' }, root)).toMatch(
      /outside/,
    );
  });
  it('discovers workspace skills from a nested product repository cwd', () => {
    const workspace = temporaryDirectory();
    const product = join(workspace, 'product');
    mkdirSync(join(workspace, '.agents', 'skills'), { recursive: true });
    mkdirSync(join(workspace, 'mg'));
    mkdirSync(product);
    writeFileSync(join(workspace, 'AGENTS.md'), '# Workspace\n');
    expect(workspaceSkillPath(product)).toBe(
      join(workspace, '.agents', 'skills'),
    );
  });

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

describe('prompt composition finalization', () => {
  const occurrences = (text: string, value: string) =>
    text.split(value).length - 1;

  it('finalizes custom and generated prompts through the same shared tail', () => {
    const common = {
      cwd: 'C:\\work',
      selectedTools: ['read'],
      toolSnippets: { read: 'Read files' },
      appendSystemPrompt: 'Appended guidance',
      contextFiles: [{ path: '/work/AGENTS.md', content: 'Project rules' }],
      skills: [skill('visible', '/work/visible/SKILL.md')],
    };

    const generated = buildSystemPrompt(common);
    const custom = buildSystemPrompt({
      ...common,
      customPrompt: 'Custom role',
    });
    for (const prompt of [generated, custom]) {
      for (const marker of [
        'Appended guidance',
        '<project_context>',
        '/work/AGENTS.md',
        '<available_skills>',
        'Current date:',
        'Current working directory: C:/work',
      ]) {
        expect(occurrences(prompt, marker), marker).toBe(1);
      }
      expect(prompt.indexOf('Appended guidance')).toBeLessThan(
        prompt.indexOf('<project_context>'),
      );
    }

    const generatedTail = generated.slice(
      generated.indexOf('<project_context>'),
    );
    const customTail = custom.slice(custom.indexOf('<project_context>'));
    expect(customTail).toBe(generatedTail);
  });

  it('omits skills when read is unavailable in either prompt branch', () => {
    const common = {
      cwd: '/work',
      selectedTools: ['bash'],
      toolSnippets: { bash: 'Run commands' },
      skills: [skill('hidden-without-read', '/work/skill/SKILL.md')],
    };

    expect(buildSystemPrompt(common)).not.toContain('<available_skills>');
    expect(
      buildSystemPrompt({ ...common, customPrompt: 'Custom role' }),
    ).not.toContain('<available_skills>');
  });
});

describe('delegate routing prompt', () => {
  it('injects routing when delegate is available without a catalog tool call', () => {
    const prompt = buildSystemPrompt(
      {
        cwd: '/work',
        selectedTools: ['delegate'],
        toolSnippets: { delegate: 'Delegate focused work' },
      },
      undefined,
      false,
    );
    expect(prompt).toContain('<delegate_routing>');
    expect(prompt).toContain('- luna-low: model=gpt-5.6-luna');
    expect(prompt).not.toContain('luna-low —');
    expect(prompt).not.toContain('delegate_models');
    const routing = prompt.slice(prompt.indexOf('<delegate_routing>'));
    expect(estimateSize(routing).tokens).toBeLessThan(1_000);
  });

  it('lists strict catalog route keys and enforced availability', () => {
    const prompt = formatDelegateRoutingConfig(
      parseDelegateConfig({
        provider: 'provider',
        maxRelativeCost: 2,
        modelCatalog: {
          'quick-low': {
            model: 'quick',
            thinking: 'low',
            relativeCost: 1,
            relativeIntelligence: 2,
            description: 'Cheap route.',
          },
          'smart-high': {
            model: 'smart',
            thinking: 'high',
            relativeCost: 3,
            relativeIntelligence: 8,
          },
        },
      }),
    );
    expect(prompt).toContain('Catalog routes:\n- quick-low: model=quick');
    expect(prompt).toContain('smart-high: model=smart');
    expect(prompt).toContain('unavailable-above-ceiling');
    expect(prompt).not.toContain('defaultThinking');
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

  it('states Pi skill-discovery limitations instead of claiming collision control', () => {
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
    expect(info).toContain('Tool parameter schemas: 0 runtime definition');
    expect(info).not.toContain('qualified identity');
  });
});
