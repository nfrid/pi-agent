import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DelegateTranscript,
  ExtensionSurfaceStack,
  renderLiveExtensionSurface,
  runtimeExtensionSurfaces,
} from './extension-surfaces';

const runtimeFixture = (extensionSurfaces: unknown): RuntimeSnapshot =>
  ({ extensionSurfaces }) as unknown as RuntimeSnapshot;

describe('live extension surface fixtures', () => {
  it('accepts bounded runtime surface records and ignores malformed entries', () => {
    expect(
      runtimeExtensionSurfaces(
        runtimeFixture([
          {
            id: 'delegate-1',
            rendererId: 'delegate.status',
            viewModel: { statuses: [] },
            placement: 'composer',
          },
          { id: '', rendererId: 'tasks.current', viewModel: {} },
          { id: 'bad', rendererId: '', viewModel: {} },
          null,
        ]),
      ),
    ).toMatchObject([
      {
        id: 'delegate-1',
        rendererId: 'delegate.status',
        placement: 'composer',
      },
    ]);
  });

  it('keeps live surfaces collapsed to compact summaries by default', () => {
    const delegate = renderLiveExtensionSurface({
      id: 'delegate-1',
      rendererId: 'delegate.status',
      viewModel: {
        statuses: [
          {
            id: 'd1',
            name: 'Compact delegate',
            state: 'running',
            route: 'luna-high',
          },
        ],
      },
    });
    const tasks = renderLiveExtensionSurface({
      id: 'tasks-1',
      rendererId: 'tasks.current',
      viewModel: {
        tasks: [{ id: 'T1', text: 'Compact task', status: 'doing' }],
      },
    });

    const markup = renderToStaticMarkup(
      <>
        {delegate}
        {tasks}
      </>,
    );
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('● Compact delegate');
    expect(markup).toContain('● Compact task');
    expect(markup).not.toContain('luna-high');
    expect(markup).not.toContain('task-progress');
  });

  it('orders tasks left of delegates and retains every row for scrolling', () => {
    const markup = renderToStaticMarkup(
      <ExtensionSurfaceStack
        runtime={runtimeFixture([
          {
            id: 'delegate-1',
            rendererId: 'delegate.status',
            viewModel: { statuses: [] },
          },
          {
            id: 'tasks-1',
            rendererId: 'tasks.current',
            viewModel: {
              tasks: Array.from({ length: 12 }, (_, index) => ({
                id: `T${index + 1}`,
                text: `Task ${index + 1}`,
                status: 'todo',
              })),
            },
          },
        ])}
      />,
    );

    expect(markup.indexOf('aria-label="Tasks"')).toBeLessThan(
      markup.indexOf('aria-label="Delegate status"'),
    );
    expect(markup).toContain('0/12 complete');
    expect(markup).not.toContain('more tasks');
  });

  it('renders ordered delegate transcript entries with bounded-history notice', () => {
    const markup = renderToStaticMarkup(
      <DelegateTranscript
        entries={[
          {
            id: '1:task',
            type: 'task',
            label: 'Task',
            text: 'Inspect the queue',
            status: 'completed',
            run: 1,
          },
          {
            id: '1:tool',
            type: 'tool',
            label: 'bash',
            text: 'npm test',
            status: 'running',
            run: 1,
          },
          {
            id: '1:response',
            type: 'assistant',
            label: 'Response',
            text: '**Done**',
            status: 'completed',
            run: 1,
          },
        ]}
        truncated
      />,
    );

    expect(markup).toContain('aria-label="Delegate transcript"');
    expect(markup).toContain('Inspect the queue');
    expect(markup).toContain('<pre>npm test</pre>');
    expect(markup).toContain('<strong>Done</strong>');
    expect(markup).toContain('Earlier transcript entries were omitted');
  });

  it('selects rich delegate and task renderers by tolerant renderer IDs', () => {
    const delegate = renderLiveExtensionSurface({
      id: 'delegate-1',
      rendererId: 'runtime.delegate.status',
      viewModel: {
        title: 'Subagents',
        statuses: [
          {
            id: 'd1',
            name: 'Fix queue handling',
            state: 'running',
            task: 'Inspect queue commands',
            activity: { type: 'tool', label: 'read', status: 'running' },
          },
        ],
      },
    });
    const tasks = renderLiveExtensionSurface({
      id: 'tasks-1',
      rendererId: 'tasks.current',
      viewModel: {
        tasks: [
          {
            id: 'T1',
            text: 'Add queue UI',
            status: 'doing',
            priority: 'high',
            dependsOn: ['T0'],
          },
          { id: 'T0', text: 'Define protocol', status: 'done' },
        ],
      },
    });
    expect(delegate).toMatchObject({
      type: expect.any(Function),
      props: {
        surface: expect.objectContaining({
          rendererId: 'runtime.delegate.status',
        }),
      },
    });
    expect(tasks).toMatchObject({
      type: expect.any(Function),
      props: {
        surface: expect.objectContaining({ rendererId: 'tasks.current' }),
      },
    });
  });
});
