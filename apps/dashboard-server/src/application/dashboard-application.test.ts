import type {
  BridgeEvent,
  RuntimeSnapshot,
  SessionSnapshot,
} from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import { projectPublicBridgeEvent } from './dashboard-application.js';

const session: SessionSnapshot = {
  id: 'session-public-1',
  file: '/tmp/session-public-1.jsonl',
  name: 'Public session',
  title: 'Public title',
  cwd: '/tmp/project',
  leafId: 'leaf-public-1',
  entriesComplete: true,
  entries: [
    {
      type: 'message',
      message: {
        role: 'user',
        content: 'distinctive transcript text that must stay private',
      },
    },
  ],
};

const runtime: RuntimeSnapshot = {
  runtimeId: 'runtime-public-1',
  ownership: 'external',
  pid: 1,
  cwd: '/tmp/project',
  liveState: 'idle',
  session,
  pendingInteractions: [],
};

describe('public runtime event projection', () => {
  it('strips eager delegate detail from public runtime surfaces', () => {
    const extensionSurfaces = [
      {
        id: 'delegate.status',
        rendererId: 'delegate.status',
        placement: 'right-rail' as const,
        viewModel: {
          version: 1,
          statuses: [
            {
              id: 'delegate-1',
              name: 'Worker',
              state: 'success',
              transcript: [{ text: 'large eager delegate transcript' }],
              result: {
                kind: 'structured',
                status: 'valid',
                value: { response: 'large eager delegate result' },
              },
            },
          ],
        },
      },
    ];
    const projected = projectPublicBridgeEvent({
      type: 'runtime.stateChanged',
      state: 'idle',
      snapshot: { extensionSurfaces },
    });
    expect(projected).toMatchObject({
      type: 'runtime.stateChanged',
      snapshot: {
        extensionSurfaces: [
          {
            viewModel: {
              statuses: [
                {
                  id: 'delegate-1',
                  name: 'Worker',
                  state: 'success',
                  result: {
                    kind: 'structured',
                    status: 'valid',
                    valueOmitted: true,
                  },
                },
              ],
            },
          },
        ],
      },
    });
    expect(JSON.stringify(projected)).not.toContain('large eager delegate');
  });

  it('strips transcript entries from all session-bearing public events', () => {
    const events: BridgeEvent[] = [
      { type: 'runtime.hello', protocolVersion: 1, snapshot: runtime },
      {
        type: 'runtime.stateChanged',
        state: 'working',
        snapshot: { session },
      },
      { type: 'session.changed', session },
      { type: 'session.snapshot', session },
    ];

    for (const event of events) {
      const projected = projectPublicBridgeEvent(event);
      const projectedSession =
        projected.type === 'runtime.hello'
          ? projected.snapshot.session
          : projected.type === 'runtime.stateChanged'
            ? projected.snapshot?.session
            : 'session' in projected
              ? projected.session
              : undefined;
      expect(projectedSession).toMatchObject({
        id: session.id,
        file: session.file,
        name: session.name,
        title: session.title,
        cwd: session.cwd,
        leafId: session.leafId,
        entries: [],
        entriesComplete: false,
      });
      expect(JSON.stringify(projected)).not.toContain(
        'distinctive transcript text that must stay private',
      );
    }
  });
});
