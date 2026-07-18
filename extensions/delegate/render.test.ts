import { initTheme, type ThemeColor } from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'vitest';
import { renderDelegateCall, renderDelegateResult } from './render';
import { createRun } from './types';

initTheme('dark', false);

const theme = {
  fg: (_color: ThemeColor, text: string) => text,
  bold: (text: string) => text,
};

const assistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
  usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
};

describe('render', () => {
  test('renders catalog routes', () => {
    const call = renderDelegateCall(
      { task: 'inspect', route: 'quick' },
      theme,
      { cwd: '/tmp/project' },
    );
    expect(call.render(200).join('\n')).toContain('quick');
  });

  test('renders labelled parallel tasks with plain-language modes', () => {
    const component = renderDelegateCall(
      {
        tasks: [
          { task: 'inspect' },
          { task: 'implement', allowWrites: true, context: 'branch' },
        ],
        cwd: '/tmp/project',
        context: 'fresh',
        route: 'quick',
      },
      theme,
      { cwd: '/tmp/project' },
    );
    const output = component.render(300).join('\n');
    expect(output).toContain('Delegate · 2 subagents');
    expect(output).toContain('1 Task  inspect');
    expect(output).toContain(
      'Fresh context · Read-only · /tmp/project · quick',
    );
    expect(output).toContain('2 Task  implement');
    expect(output).toContain('Parent context · Requests edits · /tmp/project');
  });

  test('shows the full delegated prompt when the call is expanded', () => {
    const prompt = `Inspect the project and report ${'all relevant details '.repeat(20)}`;
    const component = renderDelegateCall({ task: prompt }, theme, {
      cwd: '/tmp/project',
      expanded: true,
    });
    expect(component.render(1000).join('\n')).toContain(prompt.trim());
  });

  test('lets result details own the card after execution starts', () => {
    const component = renderDelegateCall(
      { task: 'Inspect the project' },
      theme,
      { cwd: '/tmp/project', executionStarted: true },
    );
    expect(component.render(100)).toEqual([]);
  });

  test('renders a task-first running hierarchy and dims tool metadata', () => {
    const run = createRun('Inspect the cache invalidation path', undefined, {
      cwd: '/tmp/project',
      context: 'fresh',
    });
    run.state = 'running';
    run.activities.push({
      type: 'tool',
      label: 'read /tmp/project/file.ts',
      status: 'running',
    });
    const styledTheme = {
      fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    };
    const component = renderDelegateResult(
      { details: { mode: 'single', runs: [run] } },
      { expanded: false },
      styledTheme,
    );
    const output = component.render(300).join('\n');
    expect(output).toContain('<toolTitle>Delegate</toolTitle>');
    expect(output).toContain(
      '<text>Inspect the cache invalidation path</text>',
    );
    expect(output).toContain('<success>read</success>');
    expect(output).toContain('<dim> /tmp/project/file.ts</dim>');
    expect(output).toContain(
      '<dim>Fresh context</dim><dim> · </dim><dim>Read-only</dim>',
    );
    expect(output).toContain('cancel');
  });

  test('renders worktree and patch lifecycle details with actions', () => {
    const run = createRun('Implement safely', undefined, {
      cwd: '/tmp/worktree',
      context: 'fresh',
      allowWrites: true,
      scope: ['src'],
      isolation: {
        id: '11111111-1111-1111-1111-111111111111',
        backend: 'macos-sandbox-exec',
        repositoryRoot: '/tmp/project',
        worktreePath: '/tmp/worktree',
        workingDirectory: '',
        baseHead: 'abc123',
        dependencyMode: 'isolated',
        status: 'patch-ready',
        patch: {
          sha256: 'a'.repeat(64),
          size: 42,
          changedPaths: ['src/file.ts'],
          diffCheckPassed: true,
          requiresIsolatedDependencyValidation: false,
        },
        validation: { status: 'not-run' },
      },
    });
    run.state = 'success';
    run.exitCode = 0;
    const output = renderDelegateResult(
      { details: { mode: 'single', runs: [run] } },
      { expanded: true },
      theme,
    )
      .render(300)
      .join('\n');
    expect(output).toContain('Isolation & patch');
    expect(output).toContain('State: patch-ready');
    expect(output).toContain('src/file.ts');
    expect(output).toContain('/delegate-patch');
    expect(output).toContain('Enforced scope: src');
  });

  test('dims routine startup and running status', () => {
    const run = createRun(
      'Inspect the project',
      {
        route: 'terra-medium',
        provider: 'openai-codex',
        model: 'gpt-5.6-terra',
        thinking: 'medium',
        relativeCost: 8,
        relativeIntelligence: 72,
      },
      {
        cwd: '/tmp/project',
        context: 'fresh',
      },
    );
    run.state = 'running';
    const styledTheme = {
      fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    };
    const output = renderDelegateResult(
      { details: { mode: 'single', runs: [run] } },
      { expanded: false },
      styledTheme,
    )
      .render(300)
      .join('\n');
    expect(output).toContain('<muted>…</muted>');
    expect(output).toContain('<dim>Starting subagent</dim>');
    expect(output).toContain('<accent>terra-medium</accent>');
    expect(output).not.toContain('<warning>…</warning>');
  });

  test('shows catalog route and elevated write access', () => {
    const styledTheme = {
      fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    };
    const output = renderDelegateCall(
      { task: 'inspect', route: 'quick', allowWrites: true },
      styledTheme,
      { cwd: '/tmp/project' },
    )
      .render(300)
      .join('\n');
    expect(output).toContain('<accent>quick</accent>');
    expect(output).toContain('<warning>Requests edits</warning>');
  });

  test('shows catalog route in result views', () => {
    const run = createRun(
      'Inspect the project',
      {
        route: 'terra-medium',
        provider: 'openai-codex',
        model: 'gpt-5.6-terra',
        thinking: 'medium',
        relativeCost: 8,
        relativeIntelligence: 72,
      },
      { cwd: '/tmp/project', context: 'fresh' },
    );
    run.state = 'success';
    run.exitCode = 0;
    run.model = 'gpt-5.6-terra';
    run.messages = [assistantMessage as never];
    run.finishedAt = Date.now();
    for (const expanded of [false, true]) {
      const output = renderDelegateResult(
        { details: { mode: 'single', runs: [run] } },
        { expanded },
        theme,
      )
        .render(300)
        .join('\n');
      const modeLine = output
        .split('\n')
        .find((line) => line.includes('Fresh context · Read-only'));
      expect(modeLine).toContain('terra-medium');
      expect(output).not.toMatch(/\n[ \t]*\nResult/);
    }
  });

  test('organizes expanded output into explicit sections', () => {
    const run = createRun('Recheck the cache fix', undefined, {
      cwd: '/tmp/project',
      context: 'continuation',
      continuation: 'child-token',
      contextNote: 'The parser has already been ruled out.',
      scope: ['src/cache'],
    });
    run.state = 'success';
    run.exitCode = 0;
    run.messages = [assistantMessage as never];
    run.finishedAt = Date.now();
    const component = renderDelegateResult(
      { details: { mode: 'single', runs: [run] } },
      { expanded: true },
      theme,
    );
    const output = component.render(300).join('\n');
    expect(output).toContain('Task');
    expect(output).toContain('Recheck the cache fix');
    expect(output).toContain('Mode');
    expect(output).toContain('Continued context · Read-only · /tmp/project');
    expect(output).toContain('Advisory scope: src/cache');
    expect(output).toContain(
      'Parent note: The parser has already been ruled out.',
    );
    expect(output).toContain('Result');
    expect(output).toContain('Usage & continuation');
    expect(output).toContain('Continuation: child-token');
  });

  test('keeps the task visible without duplicating a result heading', () => {
    const run = createRun('A unique delegated task', undefined, {
      cwd: '/tmp/project',
      context: 'fresh',
    });
    run.state = 'success';
    run.exitCode = 0;
    run.messages = [
      {
        ...assistantMessage,
        content: [{ type: 'text', text: '## Result\n\n- first\n- second' }],
      } as never,
    ];
    run.finishedAt = Date.now();
    for (const expanded of [false, true]) {
      const component = renderDelegateResult(
        { details: { mode: 'single', runs: [run] } },
        { expanded },
        theme,
      );
      const output = component.render(300).join('\n');
      expect(output).toContain('Delegate · done');
      expect(output).toContain('A unique delegated task');
      expect(output.match(/Result/g)).toHaveLength(1);
      expect(output).toContain('first');
      expect(output).toContain('Fresh context · Read-only · /tmp/project');
    }
  });

  test('renders partial parallel completion prominently', () => {
    const success = createRun('review', undefined, {
      cwd: '/tmp/project',
      context: 'fresh',
    });
    success.state = 'success';
    success.exitCode = 0;
    success.messages = [assistantMessage as never];
    success.finishedAt = Date.now();
    const failure = createRun('test', undefined, {
      cwd: '/tmp/project',
      context: 'fresh',
    });
    failure.state = 'error';
    failure.exitCode = 1;
    failure.errorMessage = 'Tests failed';
    failure.warnings = ['Parallel write scopes overlap.'];
    failure.finishedAt = Date.now();

    const component = renderDelegateResult(
      { details: { mode: 'parallel', runs: [success, failure] } },
      { expanded: false },
      theme,
    );
    const output = component.render(300).join('\n');
    expect(output).toContain('1/2 succeeded');
    expect(output).toContain('Partial success');
    expect(output).toContain('Warning: Parallel write scopes overlap.');
    expect(output).toContain(' 1 ✓ review');
    expect(output).toContain(' 2 × test');
    expect(output).toContain('Tests failed');
  });
});
