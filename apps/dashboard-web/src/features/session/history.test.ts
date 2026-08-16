import { DashboardLiveStore, dashboardHttpClient } from '@pi-dashboard/client';
import type {
  AuthoritativeSessionSnapshot,
  SessionApiResponse,
} from '@pi-dashboard/protocol';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
  isContiguousOlderHistory,
  sessionHistoryWindowKey,
  useOlderSessionHistory,
} from './history';

const current = {
  version: 1 as const,
  start: 20,
  end: 40,
  hasOlder: true,
  nextBefore: 'cursor-20',
};

describe('sessionHistoryWindowKey', () => {
  it('changes when an authoritative same-session snapshot rebases the feed', () => {
    const loadedOlderPages = {
      version: 1 as const,
      start: 0,
      end: 20,
      hasOlder: true,
      nextBefore: 'cursor-0',
    };
    const latestWindow = {
      version: 1 as const,
      start: 20,
      end: 40,
      hasOlder: true,
      nextBefore: 'cursor-20',
    };
    expect(sessionHistoryWindowKey(40, loadedOlderPages)).not.toBe(
      sessionHistoryWindowKey(41, latestWindow),
    );
    expect(sessionHistoryWindowKey(41, latestWindow)).toBe(
      JSON.stringify([41, 1, 20, 40, true, 'cursor-20']),
    );
  });
});

describe('useOlderSessionHistory', () => {
  it('buffers a continuation chain and publishes it atomically', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new DashboardLiveStore();
    const metadata = {
      id: 'session-1',
      file: '/tmp/session.jsonl',
      cwd: '/tmp',
      updatedAt: 1,
    };
    const active: AuthoritativeSessionSnapshot['active'] = {
      pendingInteractions: [],
      messages: [],
      tools: [],
      delegates: [],
      truncated: false,
    };
    const initial = {
      serverId: 'daemon-1',
      cursor: 1,
      metadata,
      entries: [{ type: 'tool', id: 'tool-new', tool: { name: 'read' } }],
      history: {
        version: 1 as const,
        start: 20,
        end: 30,
        hasOlder: true,
        nextBefore: 'before-20',
        leadingContinuation: true,
      },
      entriesComplete: false,
      active,
      completeThroughCursor: false,
    } as AuthoritativeSessionSnapshot;
    store.hydrateSession(initial);
    const pages = [
      {
        ...initial,
        entries: [{ type: 'tool', id: 'tool-middle', tool: { name: 'read' } }],
        history: {
          version: 1 as const,
          start: 10,
          end: 20,
          hasOlder: true,
          nextBefore: 'before-10',
          leadingContinuation: true,
        },
      },
      {
        ...initial,
        entries: [
          {
            type: 'message',
            id: 'owner',
            message: {
              role: 'assistant',
              toolCallIds: ['tool-middle', 'tool-new'],
              content: 'Inspecting the batch.',
            },
          },
        ],
        history: {
          version: 1 as const,
          start: 0,
          end: 10,
          hasOlder: false,
        },
      },
    ];
    const sessionBefore = vi
      .spyOn(dashboardHttpClient, 'sessionBefore')
      .mockImplementation(async () => {
        const page = pages.shift();
        if (!page) throw new Error('unexpected request');
        return page;
      });
    const prepend = vi.spyOn(store, 'prependSessionHistoryPages');
    let controls!: ReturnType<typeof useOlderSessionHistory>;
    function Probe() {
      controls = useOlderSessionHistory({
        id: 'session-1',
        data: initial,
        store,
        sessionMounted: true,
      });
      return null;
    }
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        renderer = create(createElement(Probe));
      });
      await vi.waitFor(() => expect(sessionBefore).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(prepend).toHaveBeenCalledTimes(1));
      expect(prepend.mock.calls[0]?.[0]).toHaveLength(2);
      expect(controls.history?.leadingContinuation).not.toBe(true);
      expect(
        store.getSnapshot().transcriptsBySessionId['session-1']?.order,
      ).toEqual(['owner', 'tool-middle', 'tool-new']);
    } finally {
      sessionBefore.mockRestore();
      prepend.mockRestore();
      renderer?.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('retries transparently when the authoritative window changes before commit', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new DashboardLiveStore();
    const metadata = {
      id: 'session-1',
      file: '/tmp/session.jsonl',
      cwd: '/tmp',
      updatedAt: 1,
    };
    const active: AuthoritativeSessionSnapshot['active'] = {
      pendingInteractions: [],
      messages: [],
      tools: [],
      delegates: [],
      truncated: false,
    };
    const initial = {
      serverId: 'daemon-1',
      cursor: 40,
      runtimeEpoch: 'epoch-1',
      metadata,
      entries: [
        {
          type: 'message',
          id: 'latest-old',
          message: { role: 'assistant', content: 'old latest window' },
        },
      ],
      history: {
        version: 1 as const,
        start: 20,
        end: 40,
        hasOlder: true,
        nextBefore: 'before-20',
      },
      entriesComplete: true,
      active,
      completeThroughCursor: true,
    } as AuthoritativeSessionSnapshot;
    const rebased = {
      ...initial,
      cursor: 41,
      entries: [
        {
          type: 'message',
          id: 'latest-new',
          message: { role: 'assistant', content: 'new latest window' },
        },
      ],
      history: {
        version: 1 as const,
        start: 21,
        end: 41,
        hasOlder: true,
        nextBefore: 'before-21',
      },
    } as AuthoritativeSessionSnapshot;
    const stalePage = {
      ...initial,
      runtimeEpoch: undefined,
      entries: [],
      history: {
        version: 1 as const,
        start: 0,
        end: 20,
        hasOlder: false,
      },
    } as AuthoritativeSessionSnapshot;
    const currentPage = {
      ...rebased,
      runtimeEpoch: undefined,
      entries: [
        {
          type: 'message',
          id: 'older-current',
          message: { role: 'user', content: 'current older page' },
        },
      ],
      history: {
        version: 1 as const,
        start: 0,
        end: 21,
        hasOlder: false,
      },
    } as AuthoritativeSessionSnapshot;
    store.hydrateSession(initial);
    const beforeCursors: string[] = [];
    const requestSignals: Array<AbortSignal | undefined> = [];
    const sessionBefore = vi
      .spyOn(dashboardHttpClient, 'sessionBefore')
      .mockImplementation(async (_id, before, signal) => {
        beforeCursors.push(before);
        requestSignals.push(signal);
        if (before === 'before-20') {
          store.hydrateSession(rebased);
          return stalePage;
        }
        if (before === 'before-21') return currentPage;
        throw new Error(`unexpected cursor ${before}`);
      });
    const reconnect = vi.spyOn(store, 'reconnectSession');
    const prepend = vi.spyOn(store, 'prependSessionHistoryPages');
    let controls!: ReturnType<typeof useOlderSessionHistory>;
    function Probe() {
      controls = useOlderSessionHistory({
        id: 'session-1',
        data: initial,
        store,
        sessionMounted: true,
      });
      return null;
    }
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        renderer = create(createElement(Probe));
      });
      await act(async () => {
        await controls.loadEarlierHistory();
        await vi.waitFor(() => expect(sessionBefore).toHaveBeenCalledTimes(2));
      });
      expect(beforeCursors).toEqual(['before-20', 'before-21']);
      expect(requestSignals[0]).toBe(requestSignals[1]);
      expect(requestSignals[0]?.aborted).toBe(false);
      expect(prepend).toHaveBeenCalledTimes(1);
      expect(reconnect).not.toHaveBeenCalled();
      expect(controls.historyError).toBeUndefined();
      expect(controls.history?.hasOlder).toBe(false);
      expect(
        store.getSnapshot().transcriptsBySessionId['session-1']?.order,
      ).toEqual(['older-current', 'latest-new']);
    } finally {
      sessionBefore.mockRestore();
      reconnect.mockRestore();
      prepend.mockRestore();
      renderer?.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('does not hide a wrong-generation page behind a coverage retry', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new DashboardLiveStore();
    const metadata = {
      id: 'session-1',
      file: '/tmp/session.jsonl',
      cwd: '/tmp',
      updatedAt: 1,
    };
    const initial = {
      serverId: 'daemon-1',
      cursor: 40,
      metadata,
      entries: [],
      history: {
        version: 1 as const,
        start: 20,
        end: 40,
        hasOlder: true,
        nextBefore: 'before-20',
      },
      entriesComplete: true,
      active: {
        pendingInteractions: [],
        messages: [],
        tools: [],
        delegates: [],
        truncated: false,
      },
      completeThroughCursor: true,
    } as AuthoritativeSessionSnapshot;
    const rebased = {
      ...initial,
      cursor: 41,
      history: {
        version: 1 as const,
        start: 21,
        end: 41,
        hasOlder: true,
        nextBefore: 'before-21',
      },
    } as AuthoritativeSessionSnapshot;
    store.hydrateSession(initial);
    const sessionBefore = vi
      .spyOn(dashboardHttpClient, 'sessionBefore')
      .mockImplementation(async () => {
        store.hydrateSession(rebased);
        return {
          ...initial,
          runtimeEpoch: 'wrong-epoch',
          history: {
            version: 1 as const,
            start: 0,
            end: 20,
            hasOlder: false,
          },
        } as AuthoritativeSessionSnapshot;
      });
    const reconnect = vi.spyOn(store, 'reconnectSession');
    let controls!: ReturnType<typeof useOlderSessionHistory>;
    function Probe() {
      controls = useOlderSessionHistory({
        id: 'session-1',
        data: initial,
        store,
        sessionMounted: true,
      });
      return null;
    }
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        renderer = create(createElement(Probe));
      });
      await act(async () => {
        await controls.loadEarlierHistory();
      });
      expect(sessionBefore).toHaveBeenCalledTimes(1);
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(controls.historyError).toBe(
        'Dashboard returned history for a different session generation.',
      );
    } finally {
      sessionBefore.mockRestore();
      reconnect.mockRestore();
      renderer?.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('aborts an old page when the authoritative window changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new DashboardLiveStore();
    const metadata = {
      id: 'session-1',
      file: '/tmp/session.jsonl',
      cwd: '/tmp',
      updatedAt: 1,
    };
    const initial = {
      metadata,
      entries: [],
      history: {
        version: 1 as const,
        start: 20,
        end: 40,
        hasOlder: true,
        nextBefore: 'before-20',
      },
      entriesComplete: true,
      cursor: 40,
    } as SessionApiResponse;
    const rebased = {
      ...initial,
      cursor: 41,
      history: {
        version: 1 as const,
        start: 20,
        end: 40,
        hasOlder: true,
        nextBefore: 'before-20',
      },
    } as SessionApiResponse;
    const page = {
      serverId: 'daemon-1',
      cursor: 40,
      metadata,
      entries: [],
      history: {
        version: 1 as const,
        start: 0,
        end: 20,
        hasOlder: false,
      },
      entriesComplete: true,
      active: {
        pendingInteractions: [],
        messages: [],
        tools: [],
        delegates: [],
        truncated: false,
      },
      completeThroughCursor: false,
    } as AuthoritativeSessionSnapshot;
    let resolvePage!: (value: AuthoritativeSessionSnapshot) => void;
    const pendingPage = new Promise<AuthoritativeSessionSnapshot>((resolve) => {
      resolvePage = resolve;
    });
    let requestSignal!: AbortSignal;
    const sessionBefore = vi
      .spyOn(dashboardHttpClient, 'sessionBefore')
      .mockImplementation(async (_id, _before, signal) => {
        requestSignal = signal as AbortSignal;
        return pendingPage;
      });
    const prepend = vi.spyOn(store, 'prependSessionHistoryPages');
    let controls!: ReturnType<typeof useOlderSessionHistory>;
    function Probe({ data }: { data: SessionApiResponse }) {
      controls = useOlderSessionHistory({
        id: 'session-1',
        data,
        store,
        sessionMounted: true,
      });
      return null;
    }
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        renderer = create(createElement(Probe, { data: initial }));
      });
      let loadPromise!: Promise<void>;
      act(() => {
        loadPromise = controls.loadEarlierHistory();
      });
      expect(requestSignal.aborted).toBe(false);

      // A structurally identical window is an ordinary render and must not
      // cancel the request.
      await act(async () => {
        renderer?.update(
          createElement(Probe, {
            data: {
              ...initial,
              history: {
                version: 1,
                start: 20,
                end: 40,
                hasOlder: true,
                nextBefore: 'before-20',
              },
            },
          }),
        );
      });
      expect(requestSignal.aborted).toBe(false);

      await act(async () => {
        renderer?.update(createElement(Probe, { data: rebased }));
      });
      expect(requestSignal.aborted).toBe(true);
      resolvePage(page);
      await act(async () => {
        await loadPromise;
      });
      expect(prepend).not.toHaveBeenCalled();
    } finally {
      sessionBefore.mockRestore();
      prepend.mockRestore();
      renderer?.unmount();
      vi.unstubAllGlobals();
    }
  });
});

describe('isContiguousOlderHistory', () => {
  it('accepts a contiguous page and advances its cursor', () => {
    expect(
      isContiguousOlderHistory(
        'session-1',
        'session-1',
        {
          version: 1,
          start: 0,
          end: 20,
          hasOlder: true,
          nextBefore: 'cursor-0',
        },
        current,
        current.nextBefore,
      ),
    ).toBe(true);
  });

  it('rejects pages that do not precede the range or repeat the cursor', () => {
    for (const page of [
      { version: 1 as const, start: 20, end: 20, hasOlder: false },
      {
        version: 1 as const,
        start: 0,
        end: 19,
        hasOlder: false,
      },
      {
        version: 1 as const,
        start: 0,
        end: 20,
        hasOlder: true,
        nextBefore: current.nextBefore,
      },
    ]) {
      expect(
        isContiguousOlderHistory(
          'session-1',
          'session-1',
          page,
          current,
          current.nextBefore,
        ),
      ).toBe(false);
    }
  });

  it('rejects a page for a different session', () => {
    expect(
      isContiguousOlderHistory(
        'session-1',
        'session-2',
        {
          version: 1,
          start: 0,
          end: 20,
          hasOlder: false,
        },
        current,
        current.nextBefore,
      ),
    ).toBe(false);
  });
});
