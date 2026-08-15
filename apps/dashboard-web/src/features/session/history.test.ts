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
    const prepend = vi.spyOn(store, 'prependSessionHistory');
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
