import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { Transcript } from '../../entities/transcript';
import { DelegateInspectorTranscript } from '../delegate-transcript-inspector';
import { FileLinkContext } from './link-context';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
const open = vi.hoisted(() => vi.fn());
vi.mock('./context', () => ({ useFileViewer: () => ({ open }) }));

const message = {
  type: 'message',
  id: 'message',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: '[Implementation](src/file.ts:3)' }],
  },
};

function clickFile(tree: ReturnType<typeof create>) {
  const link = tree.root
    .findAllByType('a')
    .find((link) => link.props.href === 'src/file.ts:3');
  expect(link).toBeDefined();
  act(() =>
    link?.props.onClick({
      preventDefault() {},
      stopPropagation() {},
      currentTarget: { focus() {} },
    }),
  );
}

describe('transcript file-link origins', () => {
  it('uses the supplied archived session cwd rather than surrounding context', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <FileLinkContext.Provider value={{ cwd: '/parent' }}>
          <Transcript entries={[message]} cwd="/archived-child" />
        </FileLinkContext.Provider>,
      );
    });
    clickFile(tree);
    expect(open).toHaveBeenLastCalledWith({
      path: 'src/file.ts',
      cwd: '/archived-child',
      startLine: 3,
      endLine: 3,
    });
    act(() => tree.unmount());
  });

  it.each([
    true,
    false,
  ])('does not leak parent cwd into bounded delegate output (known child: %s)', (known) => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <FileLinkContext.Provider value={{ cwd: '/parent' }}>
          <DelegateInspectorTranscript
            isOpen={false}
            row={{
              id: 'child',
              runId: 'run',
              lineageId: 'lineage',
              name: 'Child',
              kind: 'background',
              state: 'success',
              createdAt: 1,
              allowWrites: false,
              ...(known
                ? {
                    details: {
                      setup: {
                        cwd: '/parent',
                        worktree: { worktreePath: '/child-worktree' },
                      },
                    },
                  }
                : {}),
              transcript: [
                {
                  id: 'response',
                  type: 'assistant',
                  label: 'Response',
                  text: '[Implementation](src/file.ts:3)',
                },
              ],
            }}
          />
        </FileLinkContext.Provider>,
      );
    });
    clickFile(tree);
    expect(open).toHaveBeenLastCalledWith({
      path: 'src/file.ts',
      ...(known ? { cwd: '/child-worktree' } : {}),
      startLine: 3,
      endLine: 3,
    });
    act(() => tree.unmount());
  });
});
