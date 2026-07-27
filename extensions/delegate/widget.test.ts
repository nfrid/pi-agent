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
    expect(short[0]).toContain('1m 5s');
    expect(long.join('\n')).not.toContain('HIDDEN-TAIL');
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
    expect(narrow[0]).toMatch(/4s$/);
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

  test('previews the freshest words of a wrapped thinking line', () => {
    const lines = renderDelegateWidget(
      [
        status({
          activity: {
            type: 'thinking',
            label: 'thinking',
            latestText: `${'settled ground '.repeat(20)}newest words`,
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
    expect(lines[1]).toContain('newest words');
    expect(lines[1]).not.toContain('settled ground settled ground');
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

  test('caps detailed height and summarizes hidden subagents', () => {
    const statuses = Array.from({ length: 6 }, (_, index) =>
      status({ id: `ds-${index}`, name: `Agent ${index}` }),
    );
    const lines = renderDelegateWidget(
      statuses,
      true,
      100,
      theme as never,
      5_000,
    );
    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toContain('+2 more subagents');
  });
});
