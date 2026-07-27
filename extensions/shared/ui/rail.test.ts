import type {
  ExtensionUIContext,
  Theme,
} from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import { createRailPanel, type RailPanelOptions, renderRail } from './rail';

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function panel(options: Partial<RailPanelOptions> = {}): RailPanelOptions {
  return {
    key: 'p',
    side: 'left',
    isActive: () => true,
    render: () => ['body'],
    ...options,
  };
}

function fakeUI() {
  const setWidget = vi.fn();
  return {
    setWidget,
    ui: { setWidget } as unknown as ExtensionUIContext,
    render: (width: number) => {
      const factory = setWidget.mock.calls.filter(
        (call) => typeof call[1] === 'function',
      )[0]?.[1] as
        | ((tui: unknown, theme: Theme) => { render: (w: number) => string[] })
        | undefined;
      return factory?.({ requestRender() {} }, theme).render(width);
    },
    unmounts: () =>
      setWidget.mock.calls.filter((call) => call[1] === undefined),
  };
}

describe('renderRail', () => {
  it('puts the two sides on one row, right side against the right edge', () => {
    const lines = renderRail(
      [
        panel({
          key: 'todo',
          side: 'left',
          render: () => ['todo a', 'todo b'],
        }),
        panel({
          key: 'agents',
          side: 'right',
          maxWidth: 10,
          render: () => ['agent one'],
        }),
      ],
      40,
      theme,
    );

    expect(lines).toHaveLength(2);
    // The right column starts at width - 10 and its content is 9 wide.
    expect(lines[0]).toBe(`todo a${' '.repeat(24)}agent one`);
    expect(lines[1]).toBe('todo b');
    for (const line of lines)
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  it('never renders a side wider than it asked for', () => {
    const widths: number[] = [];
    renderRail(
      [
        panel({ key: 'todo', side: 'left' }),
        panel({
          key: 'agents',
          side: 'right',
          maxWidth: 12,
          render: (width) => {
            widths.push(width);
            return ['agents'];
          },
        }),
      ],
      120,
      theme,
    );
    expect(widths).toEqual([12]);
  });

  it('squeezes the right side before the left drops below its minimum', () => {
    const widths: number[] = [];
    renderRail(
      [
        panel({ key: 'todo', side: 'left', minWidth: 20 }),
        panel({
          key: 'agents',
          side: 'right',
          maxWidth: 30,
          minWidth: 8,
          render: (width) => {
            widths.push(width);
            return ['agents'];
          },
        }),
      ],
      36,
      theme,
    );
    expect(widths).toEqual([14]);
  });

  it('stacks when the terminal cannot hold both minimums', () => {
    const lines = renderRail(
      [
        panel({
          key: 'todo',
          side: 'left',
          minWidth: 20,
          render: () => ['todo a'],
        }),
        panel({
          key: 'agents',
          side: 'right',
          maxWidth: 20,
          minWidth: 12,
          render: () => ['agents'],
        }),
      ],
      24,
      theme,
    );
    expect(lines).toEqual(['todo a', `${' '.repeat(4)}agents`]);
  });

  it('keeps a lone right-hand panel on the right edge', () => {
    expect(
      renderRail(
        [panel({ key: 'agents', side: 'right', maxWidth: 6 })],
        20,
        theme,
      ),
    ).toEqual([`${' '.repeat(14)}body`]);
  });

  it('skips inactive panels and renders nothing when none are active', () => {
    expect(
      renderRail([panel({ key: 'todo', isActive: () => false })], 40, theme),
    ).toEqual([]);
  });
});

describe('createRailPanel', () => {
  it('renders panels from separate registrations into one host widget', () => {
    const host = fakeUI();
    const left = createRailPanel({
      key: 'test-left',
      side: 'left',
      isActive: () => true,
      render: () => ['left'],
    });
    const right = createRailPanel({
      key: 'test-right',
      side: 'right',
      maxWidth: 5,
      isActive: () => true,
      render: () => ['right'],
    });

    left.attach(host.ui);
    right.attach(host.ui);
    expect(host.render(20)).toEqual([`left${' '.repeat(11)}right`]);

    // One panel leaving must not take the other's rail down with it.
    right.detach();
    expect(host.unmounts()).toHaveLength(0);
    expect(host.render(20)).toEqual(['left']);

    left.detach();
    expect(host.unmounts()).toHaveLength(1);
  });

  // Extensions load with module caching disabled, so each one evaluates its
  // own copy of this module. The rail is only one rail if that still holds.
  it('shares one host widget between separately loaded copies', async () => {
    // The query string forces a second evaluation of the module, which is
    // what the extension loader does; TypeScript cannot resolve the specifier.
    // @ts-expect-error cache-busting import specifier
    const first = (await import('./rail.ts?copy=1')) as typeof import('./rail');
    const second = (await import(
      // @ts-expect-error cache-busting import specifier
      './rail.ts?copy=2'
    )) as typeof import('./rail');
    expect(first).not.toBe(second);

    const host = fakeUI();
    const left = first.createRailPanel({
      key: 'copy-left',
      side: 'left',
      isActive: () => true,
      render: () => ['left'],
    });
    const right = second.createRailPanel({
      key: 'copy-right',
      side: 'right',
      maxWidth: 5,
      isActive: () => true,
      render: () => ['right'],
    });
    left.attach(host.ui);
    right.attach(host.ui);

    expect(new Set(host.setWidget.mock.calls.map((call) => call[0])).size).toBe(
      1,
    );
    expect(host.render(20)).toEqual([`left${' '.repeat(11)}right`]);
    left.detach();
    right.detach();
  });
});
