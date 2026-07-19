import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateAssistantUsage,
  buildSystemPrompt,
  estimateSize,
  filterGlobalContextFiles,
  findOuterMetaSkillPath,
  formatPromptInfo,
  summarizeContextMessages,
} from './index';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'system-prompt-'));
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

function options(overrides: Record<string, unknown> = {}) {
  return {
    cwd: '/work',
    selectedTools: ['read'],
    toolSnippets: { read: 'Read files' },
    ...overrides,
  };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe('canonical prompt composition', () => {
  it('keeps the agent-repository context local to that repository', () => {
    const files = [
      { path: '/home/me/.pi/agent/AGENTS.md', content: 'agent repo rules' },
      { path: '/work/project/AGENTS.md', content: 'project rules' },
    ];
    expect(
      filterGlobalContextFiles(files, '/work/project', '/home/me/.pi/agent'),
    ).toEqual([files[1]]);
    expect(
      filterGlobalContextFiles(
        files,
        '/home/me/.pi/agent/extensions',
        '/home/me/.pi/agent',
      ),
    ).toEqual(files);
  });

  it('ignores direct prompt replacement and append inputs', () => {
    const prompt = buildSystemPrompt(
      options({
        customPrompt: 'UNCONTROLLED CUSTOM PROMPT',
        appendSystemPrompt: 'UNCONTROLLED APPEND',
        promptGuidelines: ['CONTROLLED GUIDELINE'],
      }),
      'json',
    );
    expect(prompt).toContain('expert coding assistant');
    expect(prompt).toContain('CONTROLLED GUIDELINE');
    expect(prompt).toContain('Pi is running in json mode');
    expect(prompt).not.toContain('UNCONTROLLED CUSTOM PROMPT');
    expect(prompt).not.toContain('UNCONTROLLED APPEND');
  });

  it('retains official skill loading instructions and filters explicit-only skills', () => {
    const prompt = buildSystemPrompt(
      options({
        skills: [
          skill('visible', '/work/visible/SKILL.md'),
          skill('hidden', '/work/hidden/SKILL.md', true),
        ],
      }),
    );
    expect(prompt).toContain("Use the read tool to load a skill's file");
    expect(prompt).toContain(
      'resolve it against the skill directory (parent of SKILL.md',
    );
    expect(prompt).toContain('/work/visible/SKILL.md');
    expect(prompt).not.toContain('/work/hidden/SKILL.md');
  });

  it('omits the skill index when read is unavailable', () => {
    const prompt = buildSystemPrompt(
      options({
        selectedTools: ['bash'],
        toolSnippets: { bash: 'Run commands' },
        skills: [skill('hidden-without-read', '/work/skill/SKILL.md')],
      }),
    );
    expect(prompt).not.toContain('<available_skills>');
  });
});

describe('outer meta-repository skill discovery', () => {
  it('loads a marked meta-root only from above the nearest Git root', () => {
    const meta = temporaryDirectory();
    const nestedRepo = join(meta, 'product');
    const cwd = join(nestedRepo, 'packages', 'app');
    const skills = join(meta, '.agents', 'skills');
    mkdirSync(skills, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(nestedRepo, '.git'));
    writeFileSync(join(meta, '.agents', 'meta-root'), '');
    expect(findOuterMetaSkillPath(cwd)).toBe(realpathSync(skills));
  });

  it('ignores markers and AGENTS.md inside the current Git boundary', () => {
    const repo = temporaryDirectory();
    const cwd = join(repo, 'packages', 'app');
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, '.agents', 'skills'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(repo, '.agents', 'meta-root'), '');
    writeFileSync(join(repo, 'AGENTS.md'), '# untrusted project');
    expect(findOuterMetaSkillPath(cwd)).toBeUndefined();
  });

  it('does not use arbitrary ancestor AGENTS.md files as meta markers', () => {
    const parent = temporaryDirectory();
    const repo = join(parent, 'repo');
    mkdirSync(join(parent, '.agents', 'skills'), { recursive: true });
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(parent, 'AGENTS.md'), '# not a marker');
    expect(findOuterMetaSkillPath(repo)).toBeUndefined();
  });
});

describe('prompt diagnostics', () => {
  it('summarizes generic context without retaining content', () => {
    const diagnostics = summarizeContextMessages(
      [
        {
          role: 'toolResult',
          content: [{ type: 'text', text: 'secret result' }],
        },
        { role: 'custom', content: 'private snapshot' },
      ],
      3,
    );
    expect(diagnostics).toEqual({
      calls: 3,
      messages: 2,
      retainedToolResults: { count: 1, characters: 13, tokens: 4 },
      customMessages: { count: 1, characters: 16, tokens: 4 },
    });
    expect(JSON.stringify(diagnostics)).not.toContain('private snapshot');
  });

  it('reports the emitted prompt and ignored direct inputs', () => {
    const promptOptions = options({
      customPrompt: 'custom',
      appendSystemPrompt: 'append',
      promptGuidelines: ['direct'],
    });
    const info = formatPromptInfo(
      promptOptions,
      'actual emitted prompt',
      summarizeContextMessages([]),
      aggregateAssistantUsage([]),
    );
    expect(info).toContain('Last emitted canonical system prompt: 21 chars');
    expect(info).toContain('customPrompt=6 chars, appendSystemPrompt=6 chars');
    expect(info).toContain('Structured tool prompt guidelines: 1');
  });

  it('aggregates provider usage and estimates tokens', () => {
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
        { role: 'assistant', usage: usage(10, 19) },
        { role: 'assistant', usage: usage(20, 29) },
      ]),
    ).toMatchObject({ turns: 2, input: 30, peakContext: 29 });
    expect(estimateSize('12345')).toEqual({ characters: 5, tokens: 2 });
  });
});
