import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'vitest';
import type { DelegateStatusSnapshot } from './status';
import { DELEGATE_WIDGET_MAX_WIDTH, renderDelegateWidget } from './widget';

const theme = {
  fg: (_color: string, text: string) => text,
};

const semanticTheme = {
  fg: (color: string, text: string) => {
    const codes: Record<string, number> = {
      toolTitle: 36,
      warning: 33,
      success: 32,
      accent: 35,
      muted: 90,
      dim: 2,
      text: 37,
      toolOutput: 34,
      thinkingText: 35,
    };
    const code = codes[color] ?? 37;
    return `\u001b[${code}m${text}\u001b[0m`;
  },
};

const markdownTheme = {
  heading: (text: string) => text,
  link: (text: string) => text,
  linkUrl: (text: string) => text,
  code: (text: string) => text,
  codeBlock: (text: string) => text,
  codeBlockBorder: (text: string) => text,
  quote: (text: string) => text,
  quoteBorder: (text: string) => text,
  hr: (text: string) => text,
  listBullet: (text: string) => text,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
  underline: (text: string) => text,
};

function status(
  overrides: Partial<DelegateStatusSnapshot> = {},
): DelegateStatusSnapshot {
  return {
    id: 'ds-1',
    name: 'Phase 5 review',
    kind: 'foreground',
    state: 'running',
    createdAt: 1_000,
    startedAt: 2_000,
    allowWrites: false,
    ...overrides,
  };
}

describe('delegate widget', () => {
  test('uses a stable bounded block and keeps elapsed time visible', () => {
    const width = 100;
    const short = renderDelegateWidget(
      [
        status({
          activity: {
            type: 'tool',
            label: 'read file.ts',
            status: 'running',
          },
        }),
      ],
      true,
      width,
      theme as never,
      66_000,
    );
    const long = renderDelegateWidget(
      [
        status({
          activity: {
            type: 'tool',
            label: `bash ${'very-long-command '.repeat(20)}HIDDEN-TAIL`,
            status: 'running',
          },
        }),
      ],
      true,
      width,
      theme as never,
      66_000,
    );

    const expectedLeft = width - DELEGATE_WIDGET_MAX_WIDTH;
    for (const line of [...short, ...long]) {
      expect(line.match(/^ */)?.[0]).toHaveLength(expectedLeft);
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(short[0]).toContain('Phase 5 review');
    expect(short[0]).toContain('1m 4s');
    expect(long.join('\n')).not.toContain('HIDDEN-TAIL');
  });

  test('labels each delegate pause phase and freezes reached elapsed time', () => {
    const pausing = renderDelegateWidget(
      [status({ pauseState: 'pausing' })],
      true,
      100,
      theme as never,
      66_000,
    ).join('\n');
    const paused = renderDelegateWidget(
      [status({ pauseState: 'paused', pausedAt: 12_000 })],
      true,
      100,
      theme as never,
      99_000,
    ).join('\n');

    expect(pausing).toContain('pausing');
    expect(pausing).toContain('Pausing at a safe boundary');
    expect(paused).toContain('paused');
    expect(paused).toContain('Paused at a safe boundary');
    expect(paused).toMatch(/10s/);
  });

  test('counts only active runtime and freezes it after completion', () => {
    const queued = renderDelegateWidget(
      [status({ state: 'queued', startedAt: undefined })],
      true,
      100,
      theme as never,
      60_000,
    )[0];
    const running = renderDelegateWidget(
      [status({ startedAt: 20_000 })],
      true,
      100,
      theme as never,
      60_000,
    )[0];
    const settled = renderDelegateWidget(
      [
        status({
          state: 'success',
          startedAt: 20_000,
          finishedAt: 45_000,
        }),
      ],
      true,
      100,
      theme as never,
      90_000,
    )[0];

    expect(queued).toMatch(/0s$/);
    expect(running).toMatch(/40s$/);
    expect(settled).toMatch(/done.*25s$/);
  });

  test('shows a continuation lineage as one run count with aggregate runtime', () => {
    const [line] = renderDelegateWidget(
      [
        status({
          context: 'continuation',
          runCount: 3,
          runs: [
            { state: 'success', startedAt: 1_000, finishedAt: 301_000 },
            { state: 'success', startedAt: 400_000, finishedAt: 580_000 },
            { state: 'running', startedAt: 600_000 },
          ],
        }),
      ],
      true,
      100,
      theme as never,
      720_000,
    );

    expect(line).toContain('run 3');
    expect(line).toMatch(/10m 0s$/);
    expect(line).not.toContain('/cont/');
  });

  test('shows compact route, context, and access indicators', () => {
    const readOnly = renderDelegateWidget(
      [
        status({
          route: 'terra-high',
          context: 'branch',
          allowWrites: false,
        }),
      ],
      true,
      100,
      theme as never,
      5_000,
    );
    const writableContinuation = renderDelegateWidget(
      [
        status({
          route: 'a-route-name-that-is-deliberately-too-long',
          context: 'continuation',
          allowWrites: true,
        }),
      ],
      true,
      100,
      theme as never,
      5_000,
    );

    expect(readOnly[0]).toContain('terra-high/branch/ro');
    expect(writableContinuation[0]).toContain('/cont/rw');
    expect(writableContinuation[0]).not.toContain(
      'a-route-name-that-is-deliberately-too-long',
    );
    expect(visibleWidth(writableContinuation[0])).toBeLessThanOrEqual(100);

    const narrow = renderDelegateWidget(
      [
        status({
          name: 'Phase\n5 review',
          route: 'terra\nhigh',
          context: 'fresh',
        }),
      ],
      true,
      20,
      theme as never,
      5_000,
    );
    expect(narrow[0]).toMatch(/3s$/);
    expect(narrow[0]).not.toContain('\n');
    expect(visibleWidth(narrow[0])).toBeLessThanOrEqual(20);
  });

  test('uses semantic colors for mode indicators', () => {
    const branchReadOnly = renderDelegateWidget(
      [
        status({
          route: 'terra-high',
          context: 'branch',
          allowWrites: false,
        }),
      ],
      true,
      100,
      semanticTheme as never,
      5_000,
    )[0];
    const continuedWritable = renderDelegateWidget(
      [
        status({
          route: 'sol-medium',
          context: 'continuation',
          allowWrites: true,
        }),
      ],
      true,
      100,
      semanticTheme as never,
      5_000,
    )[0];

    expect(branchReadOnly).toContain('\u001b[36mterra-high\u001b[0m');
    expect(branchReadOnly).toContain('\u001b[33mbranch\u001b[0m');
    expect(branchReadOnly).toContain('\u001b[32mro\u001b[0m');
    expect(continuedWritable).toContain('\u001b[35mcont\u001b[0m');
    expect(continuedWritable).toContain('\u001b[33mrw\u001b[0m');
  });

  test('uses semantic colors for activity content', () => {
    const lines = renderDelegateWidget(
      [
        status({
          id: 'ds-tool',
          activity: {
            type: 'tool',
            label: 'bash',
            latestText: 'npm test',
            status: 'running',
          },
        }),
        status({
          id: 'ds-thinking',
          activity: {
            type: 'thinking',
            label: 'thinking',
            latestText: 'Checking **important** paths',
            status: 'running',
          },
        }),
      ],
      true,
      100,
      semanticTheme as never,
      5_000,
      markdownTheme,
    );

    expect(lines[1]).toContain('\u001b[36mbash\u001b[0m');
    expect(lines[1]).toContain('\u001b[34mnpm test\u001b[0m');
    expect(lines[3]).toContain('\u001b[35mChecking ');
    expect(lines[3]).toContain('important');
  });

  test('shows only the action content without explanatory labels', () => {
    const lines = renderDelegateWidget(
      [
        status({
          activity: {
            type: 'tool',
            label: 'bash',
            latestText: 'npm test -- --changed',
            status: 'running',
          },
        }),
      ],
      true,
      100,
      theme as never,
      5_000,
    );
    expect(lines[1]).toContain('bash · npm test -- --changed');
    expect(lines.join('\n')).not.toMatch(/\b(?:Tool|Reasoning|Now|Last)\b/);
  });

  test('renders inline markdown in thinking previews', () => {
    const lines = renderDelegateWidget(
      [
        status({
          activity: {
            type: 'thinking',
            label: 'thinking',
            latestText: 'Checking **important** paths',
            status: 'running',
          },
        }),
      ],
      true,
      100,
      theme as never,
      5_000,
      markdownTheme,
    );
    expect(lines[1]).toContain('Checking');
    expect(lines[1]).toContain('important');
    expect(lines[1]).not.toContain('**');
    expect(lines[1]).toContain('\u001b[');
  });

  const thinkingPreview = (latestText: string) =>
    renderDelegateWidget(
      [
        status({
          activity: {
            type: 'thinking',
            label: 'thinking',
            latestText,
            status: 'running',
          },
        }),
      ],
      true,
      100,
      theme as never,
      5_000,
      markdownTheme,
    )[1];

  test('previews the freshest words of a wrapped thinking line', () => {
    const line = thinkingPreview(
      `${'settled ground '.repeat(20)}and these are the newest words to have arrived`,
    );
    expect(line).toContain('newest words');
    expect(line).not.toContain('settled ground settled ground');
  });

  test('holds the last full line until the newest one has filled out', () => {
    const line = thinkingPreview(`${'settled ground '.repeat(20)}fresh`);
    expect(line).toContain('settled ground');
    // The barely-started line would leave the row all but empty.
    expect(line.trimEnd()).not.toMatch(/fresh$/);
  });

  test('falls back safely when markdown rendering fails', () => {
    const brokenTheme = {
      ...markdownTheme,
      bold: () => {
        throw new Error('incomplete markdown render');
      },
    };
    expect(() =>
      renderDelegateWidget(
        [
          status({
            activity: {
              type: 'thinking',
              label: 'thinking',
              latestText: 'Checking **important** details',
              status: 'running',
            },
          }),
        ],
        true,
        100,
        theme as never,
        5_000,
        brokenTheme,
      ),
    ).not.toThrow();
  });

  test('never renders an empty action line', () => {
    const lines = renderDelegateWidget(
      [
        status({
          activity: { type: 'thinking', label: 'thinking', status: 'running' },
        }),
      ],
      true,
      100,
      theme as never,
      5_000,
      markdownTheme,
    );
    expect(lines[1].trim()).toBe('└ … thinking');
  });

  test('shows every tracked subagent with active work first', () => {
    const lines = renderDelegateWidget(
      [
        status({ id: 'ds-1', name: 'Queued one', state: 'queued' }),
        status({ id: 'ds-2', name: 'Queued two', state: 'queued' }),
        status({ id: 'ds-3', name: 'Queued three', state: 'queued' }),
        status({ id: 'ds-4', name: 'Queued four', state: 'queued' }),
        status({ id: 'ds-5', name: 'Running late', state: 'running' }),
      ],
      true,
      100,
      theme as never,
      5_000,
    );
    expect(lines[0]).toContain('Running late');
    expect(lines.join('\n')).toContain('Queued four');
    expect(lines).toHaveLength(10);
  });

  test('bounds completed history without hiding active or failed rows', () => {
    const successes = Array.from({ length: 10 }, (_, index) =>
      status({
        id: `success-${index}`,
        name: `Completed ${index}`,
        state: 'success',
      }),
    );
    const lines = renderDelegateWidget(
      [
        ...successes,
        status({ id: 'running', name: 'Still running', state: 'running' }),
        status({ id: 'failed', name: 'Needs attention', state: 'error' }),
      ],
      true,
      100,
      theme as never,
      5_000,
    );

    expect(lines.join('\n')).toContain('Still running');
    expect(lines.join('\n')).toContain('Needs attention');
    expect(lines.join('\n')).not.toContain('Completed 0');
    expect(lines.join('\n')).toContain('Completed 2');
    expect(lines.join('\n')).toContain('Completed 9');
    expect(lines.join('\n')).not.toContain('Completed 1');
    expect(lines.join('\n')).toContain('2 completed delegates hidden');
  });

  test('retains the newest successful rows by completion time', () => {
    const lines = renderDelegateWidget(
      [
        status({
          id: 'old',
          name: 'Old success',
          state: 'success',
          finishedAt: 900,
        }),
        status({
          id: 'new',
          name: 'New success',
          state: 'success',
          finishedAt: 9_000,
        }),
        status({ id: 'active', name: 'Active', state: 'running' }),
        status({ id: 'failed', name: 'Failed', state: 'error' }),
      ],
      true,
      100,
      theme as never,
      10_000,
    );
    expect(lines.join('\\n')).toContain('New success');
    expect(lines.join('\\n')).toContain('Active');
    expect(lines.join('\\n')).toContain('Failed');
  });

  test('breaks the compact line down by state', () => {
    const [line] = renderDelegateWidget(
      [
        status({ id: 'ds-1', state: 'running' }),
        status({ id: 'ds-2', state: 'running' }),
        status({ id: 'ds-3', state: 'queued' }),
      ],
      false,
      100,
      theme as never,
      5_000,
    );
    expect(line).toContain('3 subagents');
    expect(line).toContain('2 running, 1 queued');
    expect(line).toContain('/delegates');
  });

  test('uses one compact line for settled subagents', () => {
    const lines = renderDelegateWidget(
      [
        status({ id: 'ds-running', name: 'Still working' }),
        status({ id: 'ds-success', name: 'Ready to review', state: 'success' }),
        status({ id: 'ds-error', name: 'Failed review', state: 'error' }),
      ],
      true,
      100,
      theme as never,
      5_000,
    );
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('Still working');
    expect(lines[1]).toContain('starting');
    expect(lines[2]).toContain('Ready to review');
    expect(lines[3]).toContain('Failed review');
    expect(lines.slice(2).join('\n')).not.toContain('└');
  });
});
