import { DashboardLiveStore } from '@pi-dashboard/client';
import type {
  DelegateHistoryResponse,
  RuntimeSnapshot,
} from '@pi-dashboard/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { composeDelegateHistory } from './delegate/history-compose';
import {
  delegateHistoryInvocationToStatus,
  delegateHistorySettledRunIds,
} from './delegate-history';
import {
  DelegateInspectorDetails,
  DelegateInspectorMetadata,
  DelegateInspectorTranscript,
  delegateDetailHasError,
  delegateTranscriptItems,
  delegateTranscriptSessionId,
  omitDelegateRenderedPrompt,
  selectedDelegateRunId,
} from './delegate-transcript-inspector';
import {
  createDelegateHistoryRefreshCoordinator,
  DelegateTranscript,
  dashboardSurfacePlacement,
  delegateHistoryRevisionChanged,
  ExtensionSurfaceStack,
  reconcileDelegateLiveRuns,
  renderLiveExtensionSurface,
  runtimeExtensionSurfaces,
  runtimePauseStatus,
  shouldClearDelegateDetailSelection,
  shouldFetchDelegateDetail,
  shouldPromoteDelegateDetailSelection,
} from './extension-surfaces';
import {
  DelegateSurface,
  delegateActivityLabel,
  delegateDisplayName,
  delegateReferenceLabel,
  delegateRowActivityLabel,
  humanizeDelegateLogicalId,
  selectedDelegateInspectionRow,
} from './live-surface-renderers';
import { selectedDelegateCompositeRun } from './surfaces/delegate-surface';

const runtimeFixture = (extensionSurfaces: unknown): RuntimeSnapshot =>
  ({ extensionSurfaces }) as unknown as RuntimeSnapshot;

describe('live extension surface fixtures', () => {
  it('acquires only the explicitly opened child session and releases on selection changes', async () => {
    const store = new DashboardLiveStore();
    const releases = new Map<string, ReturnType<typeof vi.fn>>();
    const acquire = vi
      .spyOn(store, 'acquireSession')
      .mockImplementation((id) => {
        const release = vi.fn();
        releases.set(id, release);
        return { sessionId: id, release };
      });
    const row = {
      id: 'delegate-1',
      runId: 'run-1',
      sessionId: 'child-session-1',
      lineageId: 'lineage-1',
      name: 'Worker',
      kind: 'background' as const,
      state: 'running' as const,
      createdAt: 1,
      allowWrites: false,
    };
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <DelegateInspectorTranscript row={row} store={store} isOpen={false} />,
      );
    });
    expect(acquire).not.toHaveBeenCalled();

    await act(async () => {
      renderer.update(
        <DelegateInspectorTranscript row={row} store={store} isOpen />,
      );
    });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenLastCalledWith('child-session-1');

    await act(async () => {
      renderer.update(
        <DelegateInspectorTranscript
          row={{ ...row, runId: 'run-2', sessionId: 'child-session-2' }}
          store={store}
          isOpen
        />,
      );
    });
    expect(releases.get('child-session-1')).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenLastCalledWith('child-session-2');

    await act(async () => renderer.unmount());
    expect(releases.get('child-session-2')).toHaveBeenCalledTimes(1);
  });

  it('labels older delegate transcript fallback as limited', () => {
    const markup = renderToStaticMarkup(
      <DelegateInspectorTranscript
        isOpen={false}
        row={{
          id: 'legacy',
          runId: 'legacy-run',
          lineageId: 'legacy-lineage',
          name: 'Legacy worker',
          kind: 'foreground',
          state: 'success',
          createdAt: 1,
          allowWrites: false,
          transcript: [
            {
              id: 'response',
              type: 'assistant',
              label: 'Response',
              text: 'Legacy bounded output',
            },
          ],
        }}
      />,
    );
    expect(markup).toContain(
      'Limited transcript — this older delegate has no child session.',
    );
    expect(markup).toContain('Legacy bounded output');
  });

  it('refreshes delegate history only for revisions of the mounted session', () => {
    expect(
      delegateHistoryRevisionChanged(undefined, {
        id: 'session-1',
        revision: 0,
      }),
    ).toBe(false);
    expect(
      delegateHistoryRevisionChanged(
        { id: 'session-1', revision: 0 },
        { id: 'session-1', revision: 1 },
      ),
    ).toBe(true);
    expect(
      delegateHistoryRevisionChanged(
        { id: 'session-1', revision: 1 },
        { id: 'session-2', revision: 2 },
      ),
    ).toBe(false);
  });

  it('prefers the current lineage row over the inspected fallback', () => {
    const liveRow = {
      id: 'live-lineage-row',
      runId: 'run-3',
      lineageId: 'lineage-1',
      name: 'Worker',
      kind: 'background' as const,
      state: 'running' as const,
      createdAt: 1,
      allowWrites: false,
    };
    const durable = { ...liveRow, id: 'lineage-1', state: 'success' as const };
    const fallback = { ...liveRow };
    expect(
      selectedDelegateInspectionRow('lineage-1', [durable], fallback),
    ).toBe(durable);
    expect(
      selectedDelegateInspectionRow('missing', [], fallback),
    ).toBeUndefined();
  });

  it('retries unsettled durable history with a bounded fake-timer policy', () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn();
      const coordinator = createDelegateHistoryRefreshCoordinator(refresh, {
        maxRetries: 2,
        retryDelayMs: 100,
      });
      coordinator.markSettled(['run-1']);
      expect(refresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(100);
      expect(refresh).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(100);
      expect(refresh).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(100);
      expect(refresh).toHaveBeenCalledTimes(3);
      coordinator.observe(new Set(['run-1']));
      vi.advanceTimersByTime(1_000);
      expect(refresh).toHaveBeenCalledTimes(3);
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('omits only the initial rendered prompt from a canonical child transcript', () => {
    const projection = {
      sessionId: 'child',
      order: ['prompt', 'answer', 'follow-up'],
      items: {
        prompt: {
          kind: 'message' as const,
          messageId: 'prompt',
          role: 'user',
          content: 'full rendered prompt',
          status: 'finished' as const,
        },
        answer: {
          kind: 'message' as const,
          messageId: 'answer',
          role: 'assistant',
          content: 'done',
          status: 'finished' as const,
        },
        'follow-up': {
          kind: 'message' as const,
          messageId: 'follow-up',
          role: 'user',
          content: 'continue',
          status: 'finished' as const,
        },
      },
      lastCursor: 3,
      lastRuntimeSeq: 0,
      retiredEpochs: [],
    };
    const filtered = omitDelegateRenderedPrompt(projection);
    expect(filtered.order).toEqual(['answer', 'follow-up']);
    expect(filtered.items.prompt).toBeUndefined();
    expect(filtered.items['follow-up']).toBeDefined();
  });

  it('fetches persisted detail alongside canonical child transcripts', () => {
    const row = {
      id: 'lineage-1',
      runId: 'run-1',
      lineageId: 'lineage-1',
      name: 'Worker',
      kind: 'background' as const,
      state: 'success' as const,
      createdAt: 1,
      allowWrites: false,
    };
    expect(
      shouldFetchDelegateDetail({ persisted: true, live: true, row }),
    ).toBe(true);
    expect(
      shouldFetchDelegateDetail({
        persisted: true,
        live: true,
        row: { ...row, sessionId: 'child-session' },
      }),
    ).toBe(true);
    expect(
      shouldFetchDelegateDetail({
        persisted: true,
        live: true,
        row: { ...row, state: 'running' },
      }),
    ).toBe(false);
    expect(
      shouldFetchDelegateDetail({
        persisted: true,
        live: true,
        row: {
          ...row,
          transcript: [{ id: 'task', type: 'task', label: 'Task' }],
        },
      }),
    ).toBe(true);
  });

  it('preserves a selected delegate through history hydration and promotes settled detail', () => {
    expect(
      shouldClearDelegateDetailSelection({
        ownerMatches: true,
        fetching: true,
        runExists: false,
      }),
    ).toBe(false);
    expect(
      shouldClearDelegateDetailSelection({
        ownerMatches: true,
        fetching: false,
        runExists: true,
      }),
    ).toBe(false);
    expect(
      shouldClearDelegateDetailSelection({
        ownerMatches: true,
        fetching: false,
        runExists: false,
      }),
    ).toBe(true);
    expect(
      shouldPromoteDelegateDetailSelection({
        shouldFetch: false,
        ownerMatches: true,
        fetching: false,
        persistedRunExists: true,
        liveActive: false,
      }),
    ).toBe(true);
    expect(
      shouldPromoteDelegateDetailSelection({
        shouldFetch: false,
        ownerMatches: true,
        fetching: false,
        persistedRunExists: true,
        liveActive: true,
      }),
    ).toBe(false);
  });

  it('overlays an exact-lineage live run by workflow identity when run IDs differ', () => {
    const durableRun = {
      runId: 'persisted-run',
      lineageId: 'child-lineage',
      name: 'Review',
      kind: 'background' as const,
      state: 'running' as const,
      createdAt: 1,
      allowWrites: false,
      workflow: {
        logicalId: 'review',
        attempt: 1,
        identity: 'review@1',
        state: 'running' as const,
        dependencies: [],
        createdAt: 1,
        scheduledAt: 1,
      },
    };
    const history = {
      version: 2 as const,
      sessionId: 'parent',
      groups: [
        {
          id: 'child-lineage',
          ...durableRun,
          runCount: 1,
          runs: [durableRun],
        },
      ],
    };
    const live = {
      ...delegateHistoryInvocationToStatus(durableRun),
      id: 'live-status',
      runId: 'live-run',
      historical: undefined,
    };

    const model = composeDelegateHistory(history, [live]);
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.runs).toHaveLength(1);
    expect(model.groups[0]?.runs[0]).toMatchObject({
      id: 'persisted-run',
      persisted: true,
      live: true,
      row: { runId: 'live-run' },
    });
    const group = model.groups[0];
    if (!group) throw new Error('Expected the composed delegate group');
    const selected = selectedDelegateCompositeRun(group);
    expect(selected).toMatchObject({
      id: 'persisted-run',
      persisted: true,
      live: true,
      row: { runId: 'live-run' },
    });
    expect(
      shouldFetchDelegateDetail({
        ...selected,
        row: { ...selected.row, state: 'success' },
      }),
    ).toBe(true);

    const settlementKey = 'session:workflow:review@1';
    const transition = reconcileDelegateLiveRuns(
      'session',
      new Map([[settlementKey, 'running']]),
      [{ ...live, state: 'success' }],
    );
    const settledHistory = delegateHistorySettledRunIds({
      ...history,
      groups: [
        {
          ...history.groups[0],
          state: 'success',
          runs: [
            {
              ...durableRun,
              state: 'success',
              workflow: { ...durableRun.workflow, state: 'success' },
            },
          ],
        },
      ],
    });
    expect(transition.settledRunIds).toEqual(['workflow:review@1']);
    expect(settledHistory.has(transition.settledRunIds[0] ?? '')).toBe(true);
  });

  it('invalidates once for settled transitions and every disappeared run', () => {
    const transitioned = reconcileDelegateLiveRuns(
      'session-1',
      new Map([['session-1:active', 'running']]),
      [{ runId: 'active', lineageId: 'lineage-active', state: 'success' }],
    );
    expect(transitioned.shouldInvalidate).toBe(true);
    const settledAgain = reconcileDelegateLiveRuns(
      'session-1',
      transitioned.next,
      [{ runId: 'active', lineageId: 'lineage-active', state: 'success' }],
    );
    expect(settledAgain.shouldInvalidate).toBe(false);

    const disappeared = reconcileDelegateLiveRuns(
      'session-1',
      new Map([
        ['session-1:active', 'running'],
        ['session-1:settled', 'success'],
      ]),
      [],
    );
    expect(disappeared.shouldInvalidate).toBe(true);
    expect(disappeared.next.size).toBe(0);
    expect(disappeared.settledRunIds).toEqual(['settled']);
    expect(
      reconcileDelegateLiveRuns('session-1', disappeared.next, [])
        .shouldInvalidate,
    ).toBe(false);
  });

  it('does not treat a queued launch as persisted settlement evidence', () => {
    const settled = delegateHistorySettledRunIds({
      version: 2,
      sessionId: 'session-1',
      groups: [
        {
          id: 'lineage-1',
          runId: 'queued-run',
          lineageId: 'lineage-1',
          name: 'Queued review',
          kind: 'background',
          state: 'queued',
          createdAt: 1,
          allowWrites: false,
          runCount: 2,
          runs: [
            {
              runId: 'queued-run',
              lineageId: 'lineage-1',
              name: 'Queued review',
              kind: 'background',
              state: 'queued',
              createdAt: 1,
              allowWrites: false,
            },
            {
              runId: 'settled-run',
              lineageId: 'lineage-1',
              name: 'Queued review',
              kind: 'background',
              state: 'success',
              createdAt: 2,
              finishedAt: 3,
              allowWrites: false,
            },
          ],
        },
      ],
    } as unknown as DelegateHistoryResponse);
    expect([...settled]).toEqual(['settled-run']);
  });

  it('preserves an inspected historical run across refreshed options', () => {
    const option = (id: string) => ({
      id,
      label: id,
      row: {
        id,
        runId: id,
        lineageId: 'lineage-1',
        name: id,
        kind: 'background' as const,
        state: 'success' as const,
        createdAt: 1,
        allowWrites: false,
      },
    });
    const first = [option('run-1'), option('run-2')];
    expect(selectedDelegateRunId('run-1', first, false)).toBe('run-1');
    expect(
      selectedDelegateRunId(
        'run-1',
        [option('run-1'), option('run-2'), option('run-3')],
        false,
      ),
    ).toBe('run-1');
    expect(selectedDelegateRunId('run-1', [option('run-2')], false)).toBe(
      'run-2',
    );
    expect(selectedDelegateRunId('run-1', first, true)).toBe('run-2');
  });

  it('inspects the shared continuation session even when a selected run omitted it', () => {
    const option = (
      id: string,
      sessionId?: string,
    ): import('./delegate-transcript-inspector').DelegateInspectorRunOption => ({
      id,
      label: id,
      row: {
        id,
        runId: id,
        lineageId: 'lineage-1',
        name: id,
        kind: 'background',
        state: 'success',
        createdAt: 1,
        allowWrites: false,
        ...(sessionId ? { sessionId } : {}),
      },
    });
    expect(
      delegateTranscriptSessionId(option('run-1').row, [
        option('run-1'),
        option('run-2', 'child-session-shared'),
      ]),
    ).toBe('child-session-shared');
  });

  it('treats nullish successful detail errors as absent', () => {
    expect(delegateDetailHasError(undefined)).toBe(false);
    expect(delegateDetailHasError({ error: undefined })).toBe(false);
    expect(delegateDetailHasError({ error: null })).toBe(false);
    expect(delegateDetailHasError({ error: new Error('failed') })).toBe(true);
    expect(
      delegateDetailHasError({ error: new Error('failed'), loading: true }),
    ).toBe(false);
  });

  it('shows an explicit incomplete-history message in the transcript inspector', () => {
    const markup = renderToStaticMarkup(
      <DelegateTranscript
        entries={[]}
        truncated
        truncatedMessage="Delegate history is incomplete; some historical runs were omitted."
      />,
    );
    expect(markup).toContain('Delegate history is incomplete');
  });

  it('shows one explicit notice when durable history is truncated', () => {
    const markup = renderToStaticMarkup(
      <DelegateSurface
        surface={{
          id: 'delegate-history',
          rendererId: 'delegate.status',
          viewModel: { version: 1, statuses: [] },
        }}
        history={
          {
            version: 2,
            sessionId: 'offline-session',
            truncated: true,
            groups: [],
          } as DelegateHistoryResponse
        }
      />,
    );
    expect(markup).toContain('History incomplete');
  });

  it('preserves and labels durable wake history metadata', () => {
    const wakeStatus = (state: 'pending' | 'entered') =>
      delegateHistoryInvocationToStatus({
        runId: `wake-${state}`,
        lineageId: 'wake:review-ready',
        name: 'Wake review-ready',
        kind: 'background',
        state: state === 'entered' ? 'success' : 'running',
        createdAt: 1,
        allowWrites: false,
        wake: {
          id: 'review-ready',
          state,
          references: ['review@1'],
          createdAt: 1,
          ...(state === 'entered' ? { enteredAt: 2 } : {}),
          revision: 1,
          dispatchAttempts: state === 'entered' ? 1 : 0,
        },
      });
    const pending = wakeStatus('pending');
    const entered = wakeStatus('entered');
    expect(pending.wake).toMatchObject({
      id: 'review-ready',
      references: ['review@1'],
    });
    expect(delegateActivityLabel(pending, 'queued')).toBe('waiting for Review');
    expect(delegateActivityLabel(entered, 'done')).toBe('delivered for Review');
  });

  it('renders wake history inline without wake-owned rows or counts', () => {
    const markup = renderToStaticMarkup(
      <DelegateSurface
        surface={{
          id: 'delegate-wake-history',
          rendererId: 'delegate.status',
          viewModel: { version: 1, statuses: [] },
        }}
        history={
          {
            version: 2,
            sessionId: 'offline-session',
            groups: [
              {
                id: 'real-lineage',
                runId: 'real-run',
                lineageId: 'real-lineage',
                name: 'Review worker',
                kind: 'background',
                state: 'running',
                createdAt: 1,
                allowWrites: false,
                runCount: 1,
                runs: [
                  {
                    runId: 'real-run',
                    lineageId: 'real-lineage',
                    name: 'Review worker',
                    kind: 'background',
                    state: 'running',
                    createdAt: 1,
                    allowWrites: false,
                    workflow: {
                      logicalId: 'review',
                      attempt: 1,
                      identity: 'review@1',
                      state: 'running',
                      dependencies: [],
                      createdAt: 1,
                      scheduledAt: 1,
                    },
                  },
                ],
              },
              {
                id: 'wake-lineage',
                runId: 'wake-run',
                lineageId: 'wake:review-ready',
                name: 'Wake review-ready',
                kind: 'background',
                state: 'success',
                createdAt: 2,
                allowWrites: false,
                runCount: 1,
                wake: {
                  id: 'review-ready',
                  state: 'entered',
                  references: ['review@1'],
                  createdAt: 2,
                  enteredAt: 3,
                  revision: 1,
                  dispatchAttempts: 1,
                },
                runs: [],
              },
            ],
          } as DelegateHistoryResponse
        }
      />,
    );
    expect(markup).toContain('Review worker');
    expect(markup).toContain(
      'aria-label="1 running, 0 queued, 0 need attention, 0 done"',
    );
    expect(markup).not.toContain('Wake review-ready');
    expect(markup).not.toContain('wake:review-ready');
  });

  it('renders unresolved multi-reference wakes as a non-clickable condition banner', () => {
    const markup = renderToStaticMarkup(
      <DelegateSurface
        surface={{
          id: 'delegate-multi-wake',
          rendererId: 'delegate.status',
          viewModel: {
            version: 1,
            statuses: [],
            wakes: [
              {
                id: 'all-ready',
                state: 'pending',
                references: ['one@1', 'two@1'],
                waitingFor: ['two@1'],
                createdAt: 1,
              },
            ],
          },
        }}
      />,
    );
    expect(markup).toContain(
      'aria-label="0 running, 0 queued, 0 need attention, 0 done"',
    );
    expect(markup).not.toContain('delegate-row-toggle');
  });

  it('resolves resume references to delegate titles and humanizes missing titles', () => {
    const rows = [
      {
        id: 'review',
        runId: 'review-run',
        lineageId: 'review-lineage',
        name: 'Review implementation',
        kind: 'background' as const,
        state: 'success' as const,
        createdAt: 1,
        allowWrites: false,
        workflow: {
          logicalId: 'review',
          attempt: 1,
          identity: 'review@1',
          state: 'success' as const,
          dependencies: [],
          createdAt: 1,
          scheduledAt: 1,
        },
      },
    ];
    expect(delegateReferenceLabel('review@1', rows)).toBe(
      'Review implementation',
    );
    expect(delegateReferenceLabel('review@2', rows)).toBe('Review');
    expect(delegateReferenceLabel('missing-step@2', rows)).toBe('Missing Step');
    expect(
      delegateDisplayName({
        name: 'legacy-review',
        workflow: { logicalId: 'legacy-review' },
      }),
    ).toBe('Legacy Review');
    expect(
      delegateDisplayName({
        name: 'legacy-review@2',
        workflow: {
          logicalId: 'legacy-review',
          identity: 'legacy-review@2',
        },
      }),
    ).toBe('Legacy Review');
    expect(
      delegateDisplayName({
        name: 'reconnect-race-review',
        workflow: {
          logicalId: 'reconnect-race-review',
          identity: 'reconnect-race-review@1',
          name: 'reconnect-race-review',
        },
      }),
    ).toBe('Reconnect Race Review');
    expect(humanizeDelegateLogicalId('build_ui@3')).toBe('Build Ui');
  });

  it('uses a truthful fallback for settled historical rows without activity', () => {
    expect(
      delegateActivityLabel(
        {
          id: 'lineage-1',
          runId: 'run-1',
          lineageId: 'lineage-1',
          name: 'Historical worker',
          kind: 'background',
          state: 'success',
          createdAt: 1,
          allowWrites: false,
          historical: true,
          runCount: 1,
        },
        'done',
      ),
    ).toBe('1 run · historical');
    expect(
      delegateActivityLabel(
        {
          id: 'live-1',
          runId: 'run-live',
          lineageId: 'lineage-live',
          name: 'Live worker',
          kind: 'background',
          state: 'running',
          createdAt: 1,
          allowWrites: false,
        },
        'running',
      ),
    ).toBe('starting');
  });

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
              runId: 'run-d1',
              lineageId: 'lineage-d1',
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
            runId: 'run-d1',
            lineageId: 'lineage-d1',
            name: 'Compact delegate title that should remain complete when space allows',
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
            text: 'Compact task title that should remain complete when space allows',
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
    expect(markup).toContain(
      'Compact delegate title that should remain complete when space allows',
    );
    expect(markup).toContain('<b>T1</b>');
    expect(markup).toContain(
      'Compact task title that should remain complete when space allows',
    );
    expect(markup).toContain(
      'aria-label="1 running, 0 queued, 0 need attention, 0 done"',
    );
    expect(markup).toContain('aria-label="0 of 1 tasks complete"');
    expect(markup).toContain('○ 0/1');
    expect(markup).not.toContain('✓ 0/1');
    expect(markup).not.toContain('luna-high');
    expect(markup).not.toContain('task-progress');
  });

  it('lists every concurrently active task and delegate in launchers', () => {
    const delegate = renderLiveExtensionSurface({
      id: 'delegate-active',
      rendererId: 'delegate.status',
      viewModel: {
        version: 1,
        statuses: [
          {
            id: 'd1',
            runId: 'run-d1',
            lineageId: 'lineage-d1',
            name: 'First active delegate',
            kind: 'background',
            state: 'running',
            createdAt: 1,
            allowWrites: false,
          },
          {
            id: 'd2',
            runId: 'run-d2',
            lineageId: 'lineage-d2',
            name: 'Second active delegate',
            kind: 'background',
            state: 'queued',
            createdAt: 1,
            allowWrites: false,
          },
          {
            id: 'd3',
            runId: 'run-d3',
            lineageId: 'lineage-d3',
            name: 'Finished delegate',
            kind: 'background',
            state: 'success',
            createdAt: 1,
            allowWrites: false,
          },
        ],
      },
    });
    const tasks = renderLiveExtensionSurface({
      id: 'tasks-active',
      rendererId: 'tasks.current',
      viewModel: {
        version: 1,
        tasks: [
          {
            id: 'T1',
            text: 'First active task',
            status: 'doing',
            dependsOn: [],
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 'T2',
            text: 'Second active task',
            status: 'doing',
            dependsOn: [],
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 'T3',
            text: 'Queued task',
            status: 'todo',
            dependsOn: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        stats: { total: 3, active: 3, done: 0, blocked: 0, ready: 1 },
      },
    });
    const markup = renderToStaticMarkup(
      <>
        {tasks}
        {delegate}
      </>,
    );

    expect(markup).toContain('<b>T1</b>');
    expect(markup).toContain('First active task');
    expect(markup).toContain('<b>T2</b>');
    expect(markup).toContain('Second active task');
    expect(markup).not.toContain('Queued task');
    expect(markup).toContain('First active delegate');
    expect(markup).toContain('Second active delegate');
    expect(markup).not.toContain('Finished delegate');
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
                  runId: 'run-d1',
                  lineageId: 'lineage-d1',
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
    expect(markup).toContain('<b>T1</b>');
    expect(markup).toContain('Task 1');
    expect(markup).not.toContain('remaining');
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
    expect(markup).toContain('<b>T1</b>');
    expect(markup).toContain('Visible task 1');
    expect(markup).not.toContain('remaining');
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
                runId: 'run-d1',
                lineageId: 'lineage-d1',
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
    expect(markup).toContain('aria-label="0 of 1 tasks complete"');
    expect(markup).toContain('1 stopped');
    expect(markup).toContain(
      'aria-label="0 running, 0 queued, 1 need attention, 0 done"',
    );
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

  it('keeps delegate lifecycle facts in the inspector header', () => {
    const markup = renderToStaticMarkup(
      <DelegateInspectorMetadata
        now={2_000}
        row={{
          id: 'd1',
          runId: 'run-d1',
          lineageId: 'lineage-d1',
          name: 'Recover build',
          kind: 'background',
          state: 'timed-out',
          createdAt: 1,
          startedAt: 1,
          finishedAt: 2_000,
          allowWrites: true,
          capabilities: ['web'],
          runCount: 2,
          lifecycle: {
            reason: 'timeout',
            diagnostic: 'Runner disconnected after retry.',
            diagnosticFile: { path: '/tmp/diagnostic.txt', size: 12 },
            continuationUsable: true,
            writableBranchRetained: false,
            readOnlySnapshotRetained: true,
          },
        }}
      />,
    );

    expect(markup).toContain('aria-label="Delegate details"');
    expect(markup).toContain('2 attempts');
    expect(markup).toContain('web');
    expect(markup).toContain('snapshot retained');
    expect(markup).not.toContain('continuation ready');
    expect(markup).not.toContain('diagnostic available');
    expect(markup).not.toContain('Observed failure');
  });

  it('uses canonical workflow state and timestamps in inspector metadata', () => {
    const markup = renderToStaticMarkup(
      <DelegateInspectorMetadata
        now={10_000}
        row={{
          id: 'd-workflow',
          runId: 'run-workflow',
          lineageId: 'lineage-workflow',
          name: 'Settled delegate',
          kind: 'background',
          state: 'running',
          createdAt: 1,
          startedAt: 1_000,
          finishedAt: 9_000,
          allowWrites: false,
          workflow: {
            logicalId: 'review',
            attempt: 1,
            identity: 'review@1',
            state: 'success',
            dependencies: [],
            createdAt: 1,
            scheduledAt: 1,
            startedAt: 8_000,
            settledAt: 9_000,
          },
        }}
      />,
    );
    expect(markup).toContain('done');
    expect(markup).toContain('1s');
    expect(markup).not.toContain('8s');
  });

  it('uses per-delegate pause state and timestamp in inspector metadata', () => {
    const markup = renderToStaticMarkup(
      <DelegateInspectorMetadata
        now={99_000}
        row={{
          id: 'd1',
          runId: 'run-d1',
          lineageId: 'lineage-d1',
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

  it('renders dependency waits and wake effects once without a wake block', () => {
    const row = {
      id: 'ds-review',
      runId: 'run-review',
      lineageId: 'lineage-review',
      name: 'Review implementation',
      kind: 'background' as const,
      state: 'queued' as const,
      createdAt: 1,
      allowWrites: false,
      workflow: {
        logicalId: 'review',
        attempt: 1,
        identity: 'review@1',
        state: 'scheduled' as const,
        dependencies: ['impl@1'],
        waitingFor: ['impl@1'],
        reason: 'waiting for impl@1',
        createdAt: 1,
        scheduledAt: 1,
      },
    };
    const wakes = [
      {
        id: 'review-ready',
        state: 'pending' as const,
        references: ['review@1'],
        waitingFor: ['review@1'],
        createdAt: 1,
      },
    ];
    expect(delegateRowActivityLabel(row, wakes, 'queued')).toBe(
      'waiting for Impl · resumes parent',
    );
    const markup = renderToStaticMarkup(
      <DelegateSurface
        surface={{
          id: 'delegate-workflow',
          rendererId: 'delegate.status',
          viewModel: { version: 1, statuses: [row], wakes },
        }}
      />,
    );
    expect(markup).not.toContain('Wake rules');
    expect(markup).not.toContain('review-ready');
    expect(markup).not.toContain('handoff');
    expect(markup).not.toContain('payload');
  });

  it('composes the current action with a parent wake effect', () => {
    const row = {
      id: 'ds-action-wake',
      runId: 'run-action-wake',
      lineageId: 'lineage-action-wake',
      name: 'Running review',
      kind: 'background' as const,
      state: 'running' as const,
      createdAt: 1,
      allowWrites: false,
      activity: {
        type: 'tool' as const,
        label: 'Inspect files',
        latestText: 'current action',
        status: 'running' as const,
      },
      workflow: {
        logicalId: 'review',
        attempt: 1,
        identity: 'review@1',
        state: 'running' as const,
        dependencies: [],
        createdAt: 1,
        scheduledAt: 1,
      },
    };
    expect(
      delegateRowActivityLabel(
        row,
        [
          {
            id: 'wake-review',
            state: 'pending',
            references: ['review@1'],
            createdAt: 1,
          },
        ],
        'running',
      ),
    ).toBe('current action · resumes parent');
  });

  it('renders bounded dependency and input relationships in the inspector', () => {
    const row = {
      id: 'review-lineage',
      runId: 'review-run',
      lineageId: 'review-lineage',
      name: 'Review implementation',
      kind: 'background' as const,
      state: 'queued' as const,
      createdAt: 1,
      allowWrites: false,
      workflow: {
        logicalId: 'review',
        attempt: 1,
        identity: 'review@1',
        state: 'scheduled' as const,
        dependencies: ['impl@1', 'gate@1'],
        inputs: [
          {
            node: 'impl',
            identity: 'impl@1',
            include: ['report' as const, 'branch' as const],
          },
        ],
        createdAt: 1,
        scheduledAt: 1,
      },
    };
    const markup = renderToStaticMarkup(
      <DelegateInspectorDetails row={row} now={2_000} />,
    );
    expect(markup).toContain('After');
    expect(markup).toContain('gate@1');
    expect(markup).not.toContain('<dd>impl@1</dd>');
    expect(markup).toContain('Inputs');
    expect(markup).toContain('report + branch');
    expect(markup).not.toContain('upstream evidence');
  });

  it('renders structured task, mutable run scope, input evidence, and prompt', () => {
    const row = {
      id: 'review-lineage',
      runId: 'review-run',
      lineageId: 'review-lineage',
      name: 'Review implementation',
      kind: 'background' as const,
      state: 'success' as const,
      createdAt: 1,
      allowWrites: false,
      isolation: 'worktree' as const,
    };
    const markup = renderToStaticMarkup(
      <DelegateInspectorDetails
        row={row}
        now={2_000}
        details={{
          task: 'Review the **complete** implementation.\n\n- Check behavior\n- Check layout',
          setup: {
            cwd: '/repo',
            isolation: 'worktree',
            worktree: { branch: 'pi/review' },
          },
          runConfig: {
            scope: ['apps/dashboard-web', 'extensions/delegate'],
            parentContextNote: 'Keep it concise.\nCheck the drawer.',
            inputs: [
              {
                identity: 'impl@1',
                kind: 'report',
                label: 'Implementation report',
                content: 'Outcome: done\nChanged the inspector.',
              },
            ],
          },
          renderedPrompt: 'You are a child.\n\nReview the implementation.',
          truncated: false,
        }}
      />,
    );
    expect(markup).toContain(
      'Review the <strong>complete</strong> implementation.',
    );
    expect(markup).toContain('<li>Check behavior</li>');
    expect(markup).toContain('class="markdown');
    expect(markup).toContain('apps/dashboard-web');
    expect(markup).toContain('Keep it concise.');
    expect(markup).toContain('Implementation report');
    expect(markup).toContain('Outcome: done');
    expect(markup).toContain('<summary>Rendered prompt</summary>');
    expect(markup).toContain('You are a child.');
    expect(markup).not.toContain('impl@1');
  });

  it('renders live structured details as primary inspector content with a collapsed prompt', () => {
    const row = {
      id: 'live-review',
      runId: 'live-review-run',
      lineageId: 'live-review-lineage',
      name: 'Live review',
      kind: 'background' as const,
      state: 'running' as const,
      createdAt: 1,
      allowWrites: false,
      details: {
        task: 'Review the live change.',
        setup: { cwd: '/repo', isolation: 'shared' as const },
        runConfig: {
          scope: ['extensions/delegate'],
          after: ['gate@1'],
          parentContextNote: 'Parent context is bounded.',
          refreshSource: 'wip' as const,
          inputs: [
            {
              identity: 'report@1',
              kind: 'report' as const,
              label: 'Prior report',
              content: 'bounded evidence',
            },
          ],
          warnings: ['A setup warning'],
        },
        renderedPrompt: 'exact live prompt',
        truncated: false,
      },
    };
    const markup = renderToStaticMarkup(
      <DelegateInspectorDetails row={row} now={2_000} />,
    );
    expect(markup).toContain('Review the live change.');
    expect(markup).toContain('Delegate setup');
    expect(markup).toContain('extensions/delegate');
    expect(markup).toContain('Parent context is bounded.');
    expect(markup).toContain('Prior report');
    expect(markup).toContain('A setup warning');
    expect(markup).toContain('<details class="delegate-rendered-prompt">');
    expect(markup).toContain('<summary>Rendered prompt</summary>');
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
