import type { SessionIndexEntry } from '@pi-dashboard/protocol';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { RunStatusDisclosure, sessionRelationships } from './views';

const parent: SessionIndexEntry = {
  id: 'parent',
  file: '/tmp/parent.jsonl',
  cwd: '/tmp',
  updatedAt: 1,
};
const child: SessionIndexEntry = {
  id: 'child',
  file: '',
  cwd: '/tmp',
  updatedAt: 2,
  sessionKind: 'delegate',
  parentSessionId: 'parent',
};
const sessions = [parent, child];

describe('session relationships', () => {
  it('resolves both parent and child navigation', () => {
    expect(sessionRelationships('parent', parent, sessions)).toEqual({
      children: [child],
    });
    expect(sessionRelationships('child', child, sessions)).toEqual({
      parent,
      children: [],
    });
  });
});

describe('run status disclosure', () => {
  it('toggles without unmounting the existing launcher content', () => {
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(
        createElement(
          RunStatusDisclosure,
          null,
          createElement('button', { type: 'button' }, 'Open tasks'),
        ),
      );
    });
    if (!renderer) throw new Error('Disclosure renderer was not created');

    const buttons = renderer.root.findAllByType('button');
    const trigger = buttons[0];
    expect(trigger.props['aria-expanded']).toBe(false);
    expect(buttons[1].children).toEqual(['Open tasks']);

    act(() => {
      trigger.props.onClick();
    });
    expect(trigger.props['aria-expanded']).toBe(true);
    expect(renderer.root.findAllByType('button')[1].children).toEqual([
      'Open tasks',
    ]);
  });
});
