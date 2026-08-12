import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DelegateInspectorMetadata,
  DelegateStructuredResultSection,
  delegateTranscriptItems,
} from './delegate-transcript-inspector';
import {
  DelegateTranscript,
  dashboardSurfacePlacement,
  ExtensionSurfaceStack,
  renderLiveExtensionSurface,
  runtimeExtensionSurfaces,
  runtimePauseStatus,
} from './extension-surfaces';

const runtimeFixture = (extensionSurfaces: unknown): RuntimeSnapshot =>
  ({ extensionSurfaces }) as unknown as RuntimeSnapshot;

describe('live extension surface fixtures', () => {
  it('maps typed extension placement semantics to dashboard host slots', () => {
    expect(dashboardSurfacePlacement('composer')).toBe('composer');
    expect(dashboardSurfacePlacement('above-composer')).toBe('composer');
    expect(dashboardSurfacePlacement('left-rail')).toBe('main');
    expect(dashboardSurfacePlacement('right-rail')).toBe('main');
    expect(dashboardSurfacePlacement(undefined)).toBe('main');
  });

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

  it('uses pause as runtime state without rendering a composer widget', () => {
    const runtime = runtimeFixture([
      {
        id: 'pause-1',
        rendererId: 'runtime.pause-status',
        placement: 'composer',
        viewModel: {
          version: 1,
          phase: 'paused',
          delegateCount: 2,
          pausedAt: 12_345,
          label: 'Paused (with 2 delegates)',
        },
      },
      {
        id: 'delegate-1',
        rendererId: 'delegate.status',
        placement: 'composer',
        viewModel: {
          version: 1,
          statuses: [
            {
              id: 'd1',
              name: 'Still visible delegate',
              kind: 'background',
              state: 'running',
              pauseState: 'paused',
              pausedAt: 12_345,
              createdAt: 1,
              allowWrites: false,
            },
          ],
        },
      },
    ]);

    expect(runtimePauseStatus(runtime)).toMatchObject({
      label: 'Paused (with 2 delegates)',
      pausedAt: 12_345,
    });
    const markup = renderToStaticMarkup(
      <ExtensionSurfaceStack runtime={runtime} placement="composer" />,
    );
    expect(markup).not.toContain('pause-status');
    expect(markup).not.toContain('Paused (with 2 delegates)');
    expect(markup).toContain('Still visible delegate');
  });

  it('keeps live surfaces collapsed to compact summaries by default', () => {
    const delegate = renderLiveExtensionSurface({
      id: 'delegate-1',
      rendererId: 'delegate.status',
      viewModel: {
        version: 1,
        statuses: [
          {
            id: 'd1',
            name: 'Compact delegate',
            kind: 'background',
            state: 'running',
            createdAt: 1,
            allowWrites: false,
            route: 'luna-high',
          },
        ],
      },
    });
    const tasks = renderLiveExtensionSurface({
      id: 'tasks-1',
      rendererId: 'tasks.current',
      viewModel: {
        version: 1,
        tasks: [
          {
            id: 'T1',
            text: 'Compact task',
            status: 'doing',
            dependsOn: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        stats: { total: 1, active: 1, done: 0, blocked: 0, ready: 0 },
      },
    });

    const markup = renderToStaticMarkup(
      <>
        {delegate}
        {tasks}
      </>,
    );
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('<strong>Compact delegate</strong>');
    expect(markup).toContain('<strong>Compact task</strong>');
    expect(markup).toContain('1 active · 0 finished');
    expect(markup).toContain('0/1');
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
            viewModel: {
              version: 1,
              statuses: [
                {
                  id: 'd1',
                  name: 'Queued delegate',
                  kind: 'background',
                  state: 'queued',
                  createdAt: 1,
                  allowWrites: false,
                },
              ],
            },
          },
          {
            id: 'tasks-1',
            rendererId: 'tasks.current',
            viewModel: {
              version: 1,
              tasks: Array.from({ length: 12 }, (_, index) => ({
                id: `T${index + 1}`,
                text: `Task ${index + 1}`,
                status: 'todo',
                dependsOn: [],
                createdAt: 1,
                updatedAt: 1,
              })),
              stats: { total: 12, active: 12, done: 0, blocked: 0, ready: 12 },
            },
          },
        ])}
      />,
    );

    expect(markup.indexOf('aria-label="Tasks"')).toBeLessThan(
      markup.indexOf('aria-label="Delegates"'),
    );
    expect(markup).toContain('12 remaining');
    expect(markup).not.toContain('0 of 12 complete');
    expect(markup).not.toContain('more tasks');
  });

  it('uses aggregate task stats when dashboard rows are bounded', () => {
    const tasks = renderLiveExtensionSurface({
      id: 'tasks-bounded',
      rendererId: 'tasks.current',
      viewModel: {
        version: 1,
        tasks: Array.from({ length: 128 }, (_, index) => ({
          id: `T${index + 1}`,
          text: `Visible task ${index + 1}`,
          status: 'todo',
          dependsOn: [],
          createdAt: 1,
          updatedAt: 1,
        })),
        stats: { total: 150, active: 128, done: 22, blocked: 0, ready: 128 },
      },
    });
    const markup = renderToStaticMarkup(tasks);

    expect(markup).toContain('22/150');
    expect(markup).toContain('128 remaining');
    expect(markup).not.toContain('0/128');
  });

  it('omits task and delegate widgets when their row sets are empty', () => {
    const markup = renderToStaticMarkup(
      <ExtensionSurfaceStack
        runtime={runtimeFixture([
          {
            id: 'tasks-empty',
            rendererId: 'tasks.current',
            viewModel: {
              version: 1,
              tasks: [],
              stats: { total: 0, active: 0, done: 0, blocked: 0, ready: 0 },
            },
          },
          {
            id: 'delegates-empty',
            rendererId: 'delegate.status',
            viewModel: { version: 1, statuses: [] },
          },
        ])}
      />,
    );

    expect(markup).not.toContain('class="extension-surface"');
    expect(markup).not.toContain('aria-label="Tasks"');
    expect(markup).not.toContain('aria-label="Delegates"');
  });

  it('treats dropped tasks and aborted delegates as terminal states', () => {
    const markup = renderToStaticMarkup(
      <>
        {renderLiveExtensionSurface({
          id: 'tasks-terminal',
          rendererId: 'tasks.current',
          viewModel: {
            version: 1,
            tasks: [
              {
                id: 'T1',
                text: 'Superseded task',
                status: 'dropped',
                dependsOn: [],
                createdAt: 1,
                updatedAt: 2,
              },
            ],
            stats: { total: 1, active: 0, done: 0, blocked: 0, ready: 0 },
          },
        })}
        {renderLiveExtensionSurface({
          id: 'delegates-terminal',
          rendererId: 'delegate.status',
          viewModel: {
            version: 1,
            statuses: [
              {
                id: 'd1',
                name: 'Stopped delegate',
                kind: 'background',
                state: 'aborted',
                createdAt: 1,
                finishedAt: 2,
                allowWrites: false,
              },
            ],
          },
        })}
      </>,
    );

    expect(markup).toContain('No active tasks');
    expect(markup).toContain('0/1');
    expect(markup).toContain('1 stopped');
    expect(markup).toContain('0 active · 1 finished');
  });

  it('adapts delegate history through the main transcript entry components', () => {
    const markup = renderToStaticMarkup(
      <DelegateTranscript
        entries={[
          {
            id: '1:task',
            type: 'task',
            label: 'Task',
            text: 'Inspect the queue',
            status: 'completed',
            at: Date.parse('2026-08-05T18:42:00.000Z'),
            run: 1,
          },
          {
            id: '1:tool',
            type: 'tool',
            label: 'run checks',
            name: 'bash',
            arguments: { command: 'npm test' },
            result: { exitCode: 0 },
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
          {
            id: '1:error',
            type: 'error',
            label: 'Error',
            text: 'Command failed.',
            status: 'error',
            run: 1,
          },
        ]}
        truncated
      />,
    );

    expect(markup).toContain('aria-label="Delegate transcript"');
    expect(markup).toContain('dateTime="2026-08-05T18:42:00.000Z"');
    expect(markup).toContain('message-bubble message-user');
    expect(markup).toContain('Inspect the queue');
    expect(markup).toContain('tool-detail');
    expect(markup).toContain('Arguments');
    expect(markup).toContain('Result');
    expect(markup).toContain('npm test');
    expect(markup).toContain('&quot;exitCode&quot;: 0');
    expect(markup).toContain('<strong>Done</strong>');
    expect(markup).toContain('event-delegate-result event-failed');
    expect(markup).toContain(
      'Earlier transcript entries were omitted from this live view.',
    );
  });

  it('keeps stable transcript keys when a bounded window rotates', () => {
    const retained = {
      id: '2:tool-7',
      type: 'tool' as const,
      label: 'read source',
      name: 'read',
      status: 'completed' as const,
      run: 2,
    };
    const before = delegateTranscriptItems([
      { id: '1:task', type: 'task', label: 'Task', run: 1 },
      retained,
    ]);
    const after = delegateTranscriptItems([
      retained,
      { id: '2:response', type: 'assistant', label: 'Response', run: 2 },
    ]);

    expect(before[1]?.key).toBe(after[0]?.key);
  });

  it('keeps delegate lifecycle and result facts in the inspector header', () => {
    const markup = renderToStaticMarkup(
      <DelegateInspectorMetadata
        now={2_000}
        row={{
          id: 'd1',
          name: 'Recover build',
          kind: 'background',
          state: 'timed-out',
          createdAt: 1,
          startedAt: 1,
          finishedAt: 2_000,
          allowWrites: true,
          runCount: 2,
          result: { kind: 'structured', status: 'invalid' },
          lifecycle: {
            reason: 'timeout',
            diagnostic: 'Runner disconnected after retry.',
            diagnosticArtifact: { handle: 'artifact-1' },
            continuationUsable: true,
            writableBranchRetained: false,
            readOnlySnapshotRetained: true,
          },
        }}
      />,
    );

    expect(markup).toContain('aria-label="Delegate details"');
    expect(markup).toContain('2 attempts');
    expect(markup).toContain('result invalid');
    expect(markup).toContain('recovery timeout');
    expect(markup).toContain('continuation ready');
    expect(markup).toContain('read-only snapshot retained');
    expect(markup).toContain('diagnostic available');
    expect(markup).toContain('diagnostic artifact available');
    expect(markup).not.toContain('Observed failure');
  });

  it('uses per-delegate pause state and timestamp in inspector metadata', () => {
    const markup = renderToStaticMarkup(
      <DelegateInspectorMetadata
        now={99_000}
        row={{
          id: 'd1',
          name: 'Paused delegate',
          kind: 'background',
          state: 'running',
          pauseState: 'paused',
          pausedAt: 12_000,
          createdAt: 2_000,
          startedAt: 2_000,
          allowWrites: false,
        }}
      />,
    );

    expect(markup).toContain('paused');
    expect(markup).toContain('10s');
    expect(markup).not.toContain('1m');
  });

  it('renders validated structured results in a dedicated inspector section', () => {
    const markup = renderToStaticMarkup(
      <DelegateStructuredResultSection
        row={{
          id: 'd1',
          name: 'Structured audit',
          kind: 'background',
          state: 'success',
          createdAt: 1,
          finishedAt: 2,
          allowWrites: false,
          result: {
            kind: 'structured',
            status: 'valid',
            value: {
              outcome: 'done',
              findings: [
                {
                  path: 'src/index.ts',
                  summary: '# Finding\n\nUse `code`.',
                },
              ],
            },
          },
        }}
      />,
    );
    expect(markup).toContain('aria-label="Structured result"');
    expect(markup).not.toContain('aria-level=');
    expect(markup).not.toContain('role="heading"');
    expect(markup).toContain('object · 2 fields');
    expect(markup).toContain('>Findings</span>');
    expect(markup).toContain('array · 1 item');
    expect(markup).toContain('<div class="markdown">');
    expect(markup).toContain('<h1>Finding</h1>');
    expect(markup).toContain('<code>code</code>');
    expect(markup).not.toContain('<ol class="structured-result-list">');
    expect(markup).toContain('&quot;outcome&quot;: &quot;done&quot;');
    expect(markup).toContain('&quot;path&quot;: &quot;src/index.ts&quot;');
  });

  it('shows an explicit notice when a bounded live result omits its value', () => {
    const markup = renderToStaticMarkup(
      <DelegateStructuredResultSection
        row={{
          id: 'd-omitted',
          name: 'Large audit',
          kind: 'background',
          state: 'success',
          createdAt: 1,
          allowWrites: false,
          result: {
            kind: 'structured',
            status: 'valid',
            valueOmitted: true,
          },
        }}
      />,
    );
    expect(markup).toContain(
      'Structured result value unavailable in this bounded live snapshot.',
    );
    expect(markup).not.toContain('payload-preview');
  });

  it('shows structured validation errors without rendering invalid values', () => {
    const markup = renderToStaticMarkup(
      <DelegateStructuredResultSection
        row={{
          id: 'd2',
          name: 'Invalid audit',
          kind: 'foreground',
          state: 'error',
          createdAt: 1,
          allowWrites: false,
          result: {
            kind: 'structured',
            status: 'invalid',
            errors: ['/outcome: expected string', '/outcome: expected string'],
          },
        }}
      />,
    );
    expect(markup).toContain('/outcome: expected string');
    expect(markup.match(/\/outcome: expected string/g)).toHaveLength(2);
    expect(markup).not.toContain('malformed attempt value');
    expect(markup).not.toContain('payload-preview');
  });

  it('routes exact renderer IDs through schema validation and rejects suffix aliases', () => {
    const unknown = renderLiveExtensionSurface({
      id: 'delegate-1',
      rendererId: 'runtime.delegate.status',
      viewModel: { version: 1, statuses: [] },
    });
    const delegate = renderLiveExtensionSurface({
      id: 'delegate-1',
      rendererId: 'delegate.status',
      viewModel: { version: 1, statuses: [] },
    });
    const tasks = renderLiveExtensionSurface({
      id: 'tasks-1',
      rendererId: 'tasks.current',
      viewModel: {
        version: 1,
        tasks: [
          {
            id: 'T1',
            text: 'Add queue UI',
            status: 'doing',
            priority: 'high',
            dependsOn: ['T0'],
            createdAt: 1,
            updatedAt: 2,
          },
          {
            id: 'T0',
            text: 'Define protocol',
            status: 'done',
            dependsOn: [],
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        stats: { total: 2, active: 1, done: 1, blocked: 0, ready: 0 },
      },
    });
    expect(unknown).toMatchObject({ type: 'details' });
    expect(delegate).toMatchObject({
      type: expect.any(Function),
      props: {
        surface: expect.objectContaining({ rendererId: 'delegate.status' }),
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
