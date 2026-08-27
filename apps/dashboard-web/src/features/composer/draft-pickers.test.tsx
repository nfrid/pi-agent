import type { ReactNode } from 'react';
import { Button } from 'react-aria-components';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { setDraftLocation, setDraftModel } = vi.hoisted(() => ({
  setDraftLocation: vi.fn(),
  setDraftModel: vi.fn(),
}));

vi.mock('@pi-dashboard/client', () => ({
  dashboardHttpClient: {},
  gitContextQueryOptions: () => ({ queryKey: ['git-context'] }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      branch: 'main',
      dirty: true,
      changedFileCount: 2,
      localBranches: ['main', 'develop', 'feature/auth'],
    },
  }),
}));
vi.mock('react-aria-components', () => ({
  Button: ({
    children,
    isDisabled,
    onPress,
    ...props
  }: {
    children?: ReactNode;
    isDisabled?: boolean;
    onPress?: () => void;
    [key: string]: unknown;
  }) => (
    <button {...props} type="button" disabled={isDisabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock('../drafts', () => ({ setDraftLocation, setDraftModel }));

import {
  resetModelDisplayPreference,
  setModelDisplayPreference,
} from '../model-display-preferences';
import { DraftAgentPicker, DraftLocationPicker } from './draft-pickers';

const checkouts = [
  {
    id: 'main',
    projectId: 'project-1',
    kind: 'main',
    path: '/repo',
    status: 'ready',
    updatedAt: 1,
  },
  {
    id: 'busy',
    projectId: 'project-1',
    kind: 'worktree',
    path: '/repo/.worktrees/busy',
    branch: 'pi/busy',
    status: 'ready',
    activeRunId: 'run-1',
    updatedAt: 1,
  },
  {
    id: 'retired',
    projectId: 'project-1',
    kind: 'worktree',
    path: '/repo/.worktrees/retired',
    branch: 'pi/retired',
    status: 'retired',
    updatedAt: 1,
  },
] as never;

function label(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(label).join('');
  if (node && typeof node === 'object' && 'props' in node)
    return label((node as { props: { children?: unknown } }).props.children);
  return '';
}

function buttonWithLabel(renderer: ReturnType<typeof create>, text: string) {
  return renderer.root
    .findAllByType(Button)
    .find((button) => label(button.props.children).includes(text));
}

function installKeyboard() {
  const listeners = new Set<(event: { key: string }) => void>();
  vi.stubGlobal('HTMLElement', class HTMLElement {});
  vi.stubGlobal('SVGElement', class SVGElement {});
  vi.stubGlobal('addEventListener', (type: string, listener: unknown) => {
    if (type === 'keydown')
      listeners.add(listener as (event: { key: string }) => void);
  });
  vi.stubGlobal('removeEventListener', (_type: string, listener: unknown) => {
    listeners.delete(listener as (event: { key: string }) => void);
  });
  vi.stubGlobal('dispatchEvent', (event: { key: string }) => {
    for (const listener of listeners) listener(event);
    return true;
  });
}

afterEach(() => {
  setDraftLocation.mockReset();
  setDraftModel.mockReset();
  vi.unstubAllGlobals();
});

describe('draft location picker', () => {
  it('opens, exposes an explicit Done control, and closes on Escape', () => {
    installKeyboard();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <DraftLocationPicker
          draftId="draft-1"
          location={{ kind: 'current' }}
          projectId="project-1"
          projectRoot="/repo"
          checkouts={checkouts}
          disabled={false}
        />,
      );
    });
    act(() => buttonWithLabel(renderer, 'Current checkout')?.props.onPress());
    expect(buttonWithLabel(renderer, 'Done')).toBeDefined();
    act(() => buttonWithLabel(renderer, 'Existing checkout')?.props.onPress());
    expect(buttonWithLabel(renderer, 'pi/busy')?.props.isDisabled).toBe(true);
    expect(buttonWithLabel(renderer, 'pi/retired')?.props.isDisabled).toBe(
      true,
    );
    act(() => {
      globalThis.dispatchEvent({ key: 'Escape' } as unknown as Event);
    });
    expect(buttonWithLabel(renderer, 'Done')).toBeUndefined();
    renderer.unmount();
  });

  it('closes when the backdrop is pressed', () => {
    installKeyboard();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <DraftLocationPicker
          draftId="draft-1"
          location={{ kind: 'current' }}
          projectId="project-1"
          projectRoot="/repo"
          checkouts={checkouts}
          disabled={false}
        />,
      );
    });
    act(() => buttonWithLabel(renderer, 'Current checkout')?.props.onPress());
    act(() =>
      renderer.root
        .findByProps({
          'aria-label': 'Close Checkout location',
        })
        .props.onClick(),
    );
    expect(buttonWithLabel(renderer, 'Done')).toBeUndefined();
    renderer.unmount();
  });

  it('closes terminal base choices and only persists a branch after search selection', () => {
    installKeyboard();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <DraftLocationPicker
          draftId="draft-1"
          location={{ kind: 'current' }}
          projectId="project-1"
          projectRoot="/repo"
          checkouts={checkouts}
          disabled={false}
        />,
      );
    });
    act(() => buttonWithLabel(renderer, 'Current checkout')?.props.onPress());
    act(() => buttonWithLabel(renderer, 'Current work')?.props.onPress());
    expect(setDraftLocation).toHaveBeenCalledWith('draft-1', {
      kind: 'worktree',
      base: 'work',
    });
    expect(buttonWithLabel(renderer, 'Done')).toBeUndefined();

    act(() => buttonWithLabel(renderer, 'Current checkout')?.props.onPress());
    act(() => buttonWithLabel(renderer, 'Choose a branch')?.props.onPress());
    expect(setDraftLocation).toHaveBeenCalledTimes(1);
    expect(buttonWithLabel(renderer, 'develop')).toBeDefined();
    act(() => buttonWithLabel(renderer, 'develop')?.props.onPress());
    expect(setDraftLocation).toHaveBeenLastCalledWith('draft-1', {
      kind: 'worktree',
      base: 'branch',
      baseRef: 'develop',
    });
    expect(buttonWithLabel(renderer, 'Done')).toBeUndefined();
    renderer.unmount();
  });
});

describe('draft agent picker', () => {
  it('uses configured aliases and colors while retaining full model identities', () => {
    installKeyboard();
    setModelDisplayPreference('test', 'fast', {
      alias: 'Turbo',
      color: '#ff79c6',
    });
    setModelDisplayPreference('test', 'careful', {
      color: '#50fa7b',
    });
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <DraftAgentPicker
          draftId="draft-1"
          model={{ provider: 'test', model: 'fast' }}
          runtimes={
            [
              {
                runtimeId: 'runtime-1',
                modelCatalog: [
                  { provider: 'test', model: 'fast', name: 'Fast' },
                  { provider: 'test', model: 'careful', name: 'Careful' },
                ],
              },
            ] as never
          }
          disabled={false}
        />,
      );
    });
    const trigger = renderer.root.findByProps({
      className: 'draft-agent-model',
    });
    expect(label(trigger.props.children)).toBe('Turbo');
    expect(trigger.props.style).toEqual({ color: '#ff79c6' });
    act(() => buttonWithLabel(renderer, 'Turbo')?.props.onPress());
    expect(buttonWithLabel(renderer, 'test/fast')).toBeDefined();
    expect(buttonWithLabel(renderer, 'test/careful')).toBeDefined();
    expect(
      renderer.root.findAll((node) => node.props.style?.color === '#ff79c6'),
    ).not.toHaveLength(0);
    expect(
      renderer.root.findAll((node) => node.props.style?.color === '#50fa7b'),
    ).not.toHaveLength(0);
    renderer.unmount();
    resetModelDisplayPreference('test', 'fast');
    resetModelDisplayPreference('test', 'careful');
  });

  it('keeps model choice deliberate, updates thinking, and has a reachable Done', () => {
    installKeyboard();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <DraftAgentPicker
          draftId="draft-1"
          model={{ provider: 'test', model: 'fast' }}
          runtimes={
            [
              {
                runtimeId: 'runtime-1',
                modelCatalog: [
                  { provider: 'test', model: 'fast', name: 'Fast' },
                  { provider: 'test', model: 'careful', name: 'Careful' },
                ],
                thinkingLevels: ['low', 'high'],
              },
            ] as never
          }
          disabled={false}
        />,
      );
    });
    act(() => buttonWithLabel(renderer, 'Fast')?.props.onPress());
    expect(buttonWithLabel(renderer, 'Done')).toBeDefined();
    act(() => buttonWithLabel(renderer, 'Careful')?.props.onPress());
    expect(setDraftModel).toHaveBeenLastCalledWith('draft-1', {
      provider: 'test',
      model: 'careful',
    });
    expect(buttonWithLabel(renderer, 'Done')).toBeDefined();
    const chips = renderer.root
      .findAllByType(Button)
      .filter((node) => node.props.className?.startsWith('draft-picker-chip'));
    expect(chips.map((chip) => chip.props['data-thinking'])).toEqual([
      'low',
      'high',
    ]);
    expect(chips[0]?.props['aria-pressed']).toBe(false);
    act(() => buttonWithLabel(renderer, 'high')?.props.onPress());
    expect(setDraftModel).toHaveBeenLastCalledWith('draft-1', {
      provider: 'test',
      model: 'fast',
      thinking: 'high',
    });
    expect(buttonWithLabel(renderer, 'Done')).toBeDefined();
    act(() =>
      renderer.root
        .findByProps({
          'aria-label': 'Close Agent and thinking',
        })
        .props.onClick(),
    );
    expect(buttonWithLabel(renderer, 'Done')).toBeUndefined();
    renderer.unmount();
  });
});
