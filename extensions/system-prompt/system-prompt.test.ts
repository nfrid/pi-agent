import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ExtensionAPI,
  loadProjectContextFiles,
} from '@earendil-works/pi-coding-agent';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import systemPromptExtension, {
  aggregateAssistantUsage,
  buildSystemPrompt,
  estimateSize,
  filterGlobalContextFiles,
  findOuterMetaSkillPath,
  formatPromptInfo,
  isIsolatedGitWorktree,
  loadGuidelines,
  loadInstruction,
  summarizeContextMessages,
} from './index';

const temporaryDirectories: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeAll(() => {
  process.env.PI_CODING_AGENT_DIR = process.cwd();
});

afterAll(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

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
  it('loads an explicit agent-relative instruction and trims its content', () => {
    const agentDir = temporaryDirectory();
    mkdirSync(join(agentDir, 'instructions', 'agent'), { recursive: true });
    writeFileSync(
      join(agentDir, 'instructions', 'agent', 'example.md'),
      '\n  example policy  \n',
    );
    expect(loadInstruction('instructions/agent/example.md', agentDir)).toEqual({
      path: join(agentDir, 'instructions', 'agent', 'example.md'),
      content: 'example policy',
    });
  });

  it('loads non-empty bullet guidelines and rejects malformed files', () => {
    const agentDir = temporaryDirectory();
    const instructionsDir = join(agentDir, 'instructions', 'agent');
    mkdirSync(instructionsDir, { recursive: true });
    writeFileSync(
      join(instructionsDir, 'guidelines.md'),
      '- first\n- second\n',
    );
    expect(
      loadGuidelines('instructions/agent/guidelines.md', agentDir),
    ).toEqual(['first', 'second']);
    writeFileSync(join(instructionsDir, 'guidelines.md'), '# heading');
    expect(() =>
      loadGuidelines('instructions/agent/guidelines.md', agentDir),
    ).toThrow(/only non-empty '- ' bullet entries.*line 1/);
    writeFileSync(join(instructionsDir, 'guidelines.md'), '');
    expect(() =>
      loadGuidelines('instructions/agent/guidelines.md', agentDir),
    ).toThrow(/guideline file is empty/);
  });

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

  it('filters only paired context files across real nested and external worktrees', () => {
    const main = temporaryDirectory();
    const externalParent = temporaryDirectory();
    const nested = join(main, '.worktrees', 'nested');
    const external = join(externalParent, 'external');
    execFileSync('git', ['init', '-q', main]);
    execFileSync('git', ['-C', main, 'config', 'user.name', 'Test']);
    execFileSync('git', [
      '-C',
      main,
      'config',
      'user.email',
      'test@example.invalid',
    ]);
    writeFileSync(join(main, 'README.md'), 'fixture');
    execFileSync('git', ['-C', main, 'add', 'README.md']);
    execFileSync('git', ['-C', main, 'commit', '-qm', 'init']);
    execFileSync('git', [
      '-C',
      main,
      'worktree',
      'add',
      '-q',
      '-b',
      'nested-fixture',
      nested,
    ]);
    execFileSync('git', [
      '-C',
      main,
      'worktree',
      'add',
      '-q',
      '-b',
      'external-fixture',
      external,
    ]);
    mkdirSync(join(main, 'packages'), { recursive: true });
    mkdirSync(join(nested, 'packages'), { recursive: true });
    mkdirSync(join(external, 'packages'), { recursive: true });
    mkdirSync(join(main, 'docs'), { recursive: true });
    mkdirSync(join(nested, 'docs'), { recursive: true });
    mkdirSync(join(external, 'docs'), { recursive: true });
    writeFileSync(join(main, 'AGENTS.md'), 'original');
    writeFileSync(join(nested, 'AGENTS.override.md'), 'diverged nested');
    writeFileSync(
      join(main, 'packages', 'AGENTS.MD'),
      'original nested instruction',
    );
    writeFileSync(
      join(nested, 'packages', 'CLAUDE.MD'),
      'diverged nested instruction',
    );
    writeFileSync(join(main, 'docs', 'CLAUDE.md'), 'original docs instruction');
    writeFileSync(
      join(nested, 'docs', 'AGENTS.md'),
      'diverged docs instruction',
    );
    const ancestor = join(externalParent, 'AGENTS.md');
    writeFileSync(ancestor, 'distinct ancestor');
    const files = [
      { path: join(main, 'AGENTS.md'), content: 'original' },
      {
        path: join(nested, 'AGENTS.override.md'),
        content: 'diverged nested',
      },
      {
        path: join(main, 'packages', 'AGENTS.MD'),
        content: 'original nested instruction',
      },
      {
        path: join(nested, 'packages', 'CLAUDE.MD'),
        content: 'diverged nested instruction',
      },
      {
        path: join(main, 'docs', 'CLAUDE.md'),
        content: 'original docs instruction',
      },
      {
        path: join(nested, 'docs', 'AGENTS.md'),
        content: 'diverged docs instruction',
      },
      { path: ancestor, content: 'distinct ancestor' },
    ];

    for (const [cwd, worktreeRoot] of [
      [join(nested, 'packages'), nested],
      [join(external, 'packages'), external],
    ] as const) {
      const worktreeFiles = [
        files[0],
        {
          path: join(worktreeRoot, 'AGENTS.override.md'),
          content: 'diverged worktree instruction',
        },
        files[2],
        {
          path: join(worktreeRoot, 'packages', 'CLAUDE.MD'),
          content: 'diverged nested instruction',
        },
        files[4],
        {
          path: join(worktreeRoot, 'docs', 'AGENTS.md'),
          content: 'diverged docs instruction',
        },
        files[6],
      ];
      writeFileSync(worktreeFiles[1].path, worktreeFiles[1].content);
      writeFileSync(worktreeFiles[3].path, worktreeFiles[3].content);
      writeFileSync(worktreeFiles[5].path, worktreeFiles[5].content);
      const filtered = filterGlobalContextFiles(worktreeFiles, cwd, main);
      expect(filtered.map((file) => file.path)).toEqual([
        join(worktreeRoot, 'AGENTS.override.md'),
        join(worktreeRoot, 'packages', 'CLAUDE.MD'),
        join(worktreeRoot, 'docs', 'AGENTS.md'),
        ancestor,
      ]);
    }

    const loaded = loadProjectContextFiles({
      cwd: join(nested, 'packages'),
      agentDir: main,
    });
    expect(loaded.map((file) => file.path.toLowerCase())).toEqual([
      join(main, 'AGENTS.md').toLowerCase(),
      join(nested, 'AGENTS.override.md').toLowerCase(),
      join(nested, 'packages', 'CLAUDE.MD').toLowerCase(),
    ]);
    expect(
      filterGlobalContextFiles(loaded, join(nested, 'packages'), main).map(
        (file) => file.path.toLowerCase(),
      ),
    ).toEqual([
      join(nested, 'AGENTS.override.md').toLowerCase(),
      join(nested, 'packages', 'CLAUDE.MD').toLowerCase(),
    ]);

    const unpaired = [files[0], files[6]];
    expect(
      filterGlobalContextFiles(unpaired, join(nested, 'packages'), main),
    ).toEqual(unpaired);
  });

  it('injects completion guidance only for a main agent in a linked worktree', () => {
    const checkout = temporaryDirectory();
    const nested = join(checkout, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    const gitDir = join(checkout, '.git-common', 'worktrees', 'task');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'commondir'), '../..\n');
    writeFileSync(join(checkout, '.git'), `gitdir: ${gitDir}\n`);
    expect(isIsolatedGitWorktree(nested)).toBe(true);

    const previousDelegateChild = process.env.PI_DELEGATE_CHILD;
    delete process.env.PI_DELEGATE_CHILD;
    try {
      const prompt = buildSystemPrompt(options({ cwd: nested }), 'json');
      expect(prompt).toContain(
        'This main agent is running in an isolated Git worktree.',
      );
      expect(prompt).toContain(
        'ask the user whether to merge the finished branch into its parent branch',
      );
      expect(prompt).not.toContain('clean up the worktree');

      process.env.PI_DELEGATE_CHILD = '1';
      expect(buildSystemPrompt(options({ cwd: nested }), 'json')).not.toContain(
        'This main agent is running in an isolated Git worktree.',
      );
    } finally {
      if (previousDelegateChild === undefined)
        delete process.env.PI_DELEGATE_CHILD;
      else process.env.PI_DELEGATE_CHILD = previousDelegateChild;
    }

    const mainCheckout = temporaryDirectory();
    mkdirSync(join(mainCheckout, '.git'));
    expect(isIsolatedGitWorktree(mainCheckout)).toBe(false);
    expect(
      buildSystemPrompt(options({ cwd: mainCheckout }), 'json'),
    ).not.toContain('This main agent is running in an isolated Git worktree.');

    const malformedCheckout = temporaryDirectory();
    const malformedGitDir = join(
      malformedCheckout,
      '.git-common',
      'worktrees',
      'task',
    );
    mkdirSync(malformedGitDir, { recursive: true });
    writeFileSync(
      join(malformedCheckout, '.git'),
      `gitdir: ${malformedGitDir}\n`,
    );
    expect(isIsolatedGitWorktree(malformedCheckout)).toBe(false);
  });

  it('teaches JSON-mode delegate children to announce activity preambles', () => {
    const previousDelegateChild = process.env.PI_DELEGATE_CHILD;
    process.env.PI_DELEGATE_CHILD = '1';
    try {
      for (const guideline of loadGuidelines(
        'extensions/activity-groups/instructions.md',
      )) {
        expect(buildSystemPrompt(options(), 'json')).toContain(guideline);
      }
    } finally {
      if (previousDelegateChild === undefined)
        delete process.env.PI_DELEGATE_CHILD;
      else process.env.PI_DELEGATE_CHILD = previousDelegateChild;
    }
  });

  it('does not support direct prompt replacement or append inputs', () => {
    const prompt = buildSystemPrompt(
      options({
        customPrompt: 'UNCONTROLLED CUSTOM PROMPT',
        appendSystemPrompt: 'UNCONTROLLED APPEND',
        promptGuidelines: ['CONTROLLED GUIDELINE'],
      }),
      'json',
    );
    expect(prompt).toContain('coding agent in pi');
    expect(prompt).toContain('CONTROLLED GUIDELINE');
    expect(prompt).toContain('Pi is running in json mode');
    expect(prompt).not.toContain('UNCONTROLLED CUSTOM PROMPT');
    expect(prompt).not.toContain('UNCONTROLLED APPEND');
  });

  it('warns once per session when direct prompt inputs are discarded', () => {
    const notifications: string[] = [];
    const handlers = new Map<
      string,
      (event?: unknown, ctx?: unknown) => unknown
    >();
    systemPromptExtension({
      on: (
        name: string,
        handler: (event: unknown, ctx: unknown) => unknown,
      ) => {
        handlers.set(name, handler);
      },
      registerCommand: () => {},
    } as unknown as ExtensionAPI);
    const ctx = {
      mode: 'json',
      hasUI: true,
      ui: { notify: (message: string) => notifications.push(message) },
    };
    const invoke = (customPrompt = '', appendSystemPrompt = '') =>
      handlers.get('before_agent_start')?.(
        { systemPromptOptions: options({ customPrompt, appendSystemPrompt }) },
        ctx,
      );

    invoke();
    expect(notifications).toHaveLength(0);
    const canonical = invoke('secret custom', 'secret append') as {
      systemPrompt: string;
    };
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).not.toContain('secret');
    expect(canonical.systemPrompt).not.toContain('secret');
    invoke('second custom');
    expect(notifications).toHaveLength(1);

    handlers.get('session_start')?.();
    invoke('', 'after reset');
    expect(notifications).toHaveLength(2);
  });

  it('warns through stderr-safe output without UI in headless mode', () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handlers = new Map<
      string,
      (event?: unknown, ctx?: unknown) => unknown
    >();
    systemPromptExtension({
      on: (
        name: string,
        handler: (event: unknown, ctx: unknown) => unknown,
      ) => {
        handlers.set(name, handler);
      },
      registerCommand: () => {},
    } as unknown as ExtensionAPI);
    const ctx = { mode: 'print', hasUI: false, ui: {} };
    const event = {
      systemPromptOptions: options({ customPrompt: 'discarded' }),
    };
    handlers.get('before_agent_start')?.(event, ctx);
    handlers.get('before_agent_start')?.(event, ctx);
    expect(warnings).toHaveBeenCalledTimes(1);
    warnings.mockRestore();
  });

  it('loads each Markdown instruction exactly once in interactive and headless prompts', () => {
    const prompts = [
      buildSystemPrompt(options(), 'tui'),
      buildSystemPrompt(options(), 'json'),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain('<agent_instructions>\n# Working style');
      expect(prompt).toContain('\n\n# Interaction\n');
      expect(prompt).toContain('\n\n# Tool use\n');
      expect(prompt).toContain('\n\n- Keep command output bounded');
      expect(prompt).toContain(
        'For non-trivial `bash` calls—compound or control-flow commands, mutating commands, or otherwise non-obvious commands—provide the optional `description` field.',
      );
      expect(prompt).toContain(
        'do not add individual tool-call narration when the surrounding guidance says not to.',
      );
      expect(prompt).toContain('\n</agent_instructions>');
      expect(prompt.match(/# Working style/g)).toHaveLength(1);
      expect(prompt.match(/# Interaction/g)).toHaveLength(1);
      expect(prompt.match(/# Tool use/g)).toHaveLength(1);
      expect(prompt).not.toContain('<agent_instruction source=');
      expect(prompt).not.toContain('instructions/agent/working-style.md');
      expect(prompt).not.toContain('instructions/agent/interaction.md');
    }
  });

  it('keeps work-mode and repair-loop guidance in the canonical agent prompt', () => {
    const prompt = buildSystemPrompt(options(), 'json');
    expect(prompt).toContain(
      'Keep the current work mode across turns—exploration, plan-only, implementation, review, or operation.',
    );
    expect(prompt).toContain(
      'Leave plan-only only after an explicit transition; do not edit before then.',
    );
    expect(prompt).toContain(
      'Treat scope-changing corrections as updates to accepted constraints and preserve resulting non-goals without verbose restatement.',
    );
    expect(prompt).toContain(
      'If repeated attempts yield no new evidence, report the blocker and do not widen the scope.',
    );
    expect(prompt.match(/Keep the current work mode/g)).toHaveLength(1);
  });

  it('keeps simplicity and scope guidance in the canonical agent prompt', () => {
    const prompt = buildSystemPrompt(options(), 'json');
    expect(prompt).toContain('Choose the smallest complete implementation.');
    expect(prompt).toContain(
      'Use DRY to prevent behavior from drifting, not to eliminate every repeated line.',
    );
    expect(prompt).toContain('Treat scope spillover as a defect.');
    expect(prompt).toContain(
      'Remove unused production code; retain tests and tooling that verify supported behavior.',
    );
    expect(prompt).toContain(
      'After implementation, run a deletion pass for unnecessary additions and code made obsolete by this change.',
    );
    expect(prompt.match(/Treat scope spillover as a defect/g)).toHaveLength(1);
  });

  it('includes activity guidance only in transcript-rendering modes', () => {
    const previousDelegateChild = process.env.PI_DELEGATE_CHILD;
    delete process.env.PI_DELEGATE_CHILD;
    let tuiPrompt: string;
    let rpcPrompt: string;
    let defaultPrompt: string;
    let headlessPrompt: string;
    try {
      tuiPrompt = buildSystemPrompt(options(), 'tui');
      rpcPrompt = buildSystemPrompt(options(), 'rpc');
      defaultPrompt = buildSystemPrompt(options());
      headlessPrompt = buildSystemPrompt(options(), 'json');
    } finally {
      if (previousDelegateChild === undefined)
        delete process.env.PI_DELEGATE_CHILD;
      else process.env.PI_DELEGATE_CHILD = previousDelegateChild;
    }

    for (const guideline of loadGuidelines(
      'extensions/activity-groups/instructions.md',
    )) {
      for (const prompt of [tuiPrompt, rpcPrompt, defaultPrompt]) {
        expect(prompt).toContain(guideline);
      }
      expect(headlessPrompt).not.toContain(guideline);
    }
  });

  it('fails clearly when a required instruction file is missing', () => {
    const agentDir = temporaryDirectory();
    mkdirSync(join(agentDir, 'instructions', 'agent'), { recursive: true });
    writeFileSync(
      join(agentDir, 'instructions', 'agent', 'working-style.md'),
      'working style',
    );
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      expect(() => buildSystemPrompt(options(), 'tui')).toThrow(
        /Required agent instruction could not be loaded: instructions\/agent\/interaction\.md/,
      );
    } finally {
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
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
  it('does not contribute ambient meta skills to delegate children', () => {
    const meta = temporaryDirectory();
    const repo = join(meta, 'product');
    const skills = join(meta, '.agents', 'skills');
    mkdirSync(skills, { recursive: true });
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(meta, '.agents', 'meta-root'), '');
    const handlers = new Map<string, (event: { cwd: string }) => unknown>();
    systemPromptExtension({
      on: (name: string, handler: (event: { cwd: string }) => unknown) => {
        handlers.set(name, handler);
      },
      registerCommand: () => {},
    } as unknown as ExtensionAPI);
    const discover = handlers.get('resources_discover');
    expect(discover).toBeDefined();
    const previous = process.env.PI_DELEGATE_CHILD;
    try {
      delete process.env.PI_DELEGATE_CHILD;
      expect(discover?.({ cwd: repo })).toEqual({
        skillPaths: [realpathSync(skills)],
      });
      process.env.PI_DELEGATE_CHILD = '1';
      expect(discover?.({ cwd: repo })).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PI_DELEGATE_CHILD;
      else process.env.PI_DELEGATE_CHILD = previous;
    }
  });

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
      selectedTools: ['read', 'delegate'],
    });
    const info = formatPromptInfo(
      promptOptions,
      'actual emitted prompt',
      summarizeContextMessages([]),
      aggregateAssistantUsage([]),
    );
    expect(info).toContain('Last emitted canonical system prompt: 21 chars');
    expect(info).toContain(
      'Unsupported direct prompt inputs (not loaded): customPrompt=6 chars, appendSystemPrompt=6 chars',
    );
    expect(info).toContain('Human instruction sources: 3');
    expect(info).toContain('working-style.md:');
    expect(info).toContain('interaction.md:');
    expect(info).toContain('tool-use.md:');
    expect(info).not.toContain('delegate/parent.md');
    expect(info).not.toContain('delegate/routing.md');
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
