import { describe, expect, it } from 'vitest';
import {
  isBridgeEvent,
  MAX_FRAME_BYTES,
  parseFrame,
  serializeFrame,
  validateBridgeCommand,
  validateStartRuntimeRequest,
} from './index.js';

describe('dashboard protocol', () => {
  it('round trips bounded commands', () => {
    const frame = {
      kind: 'command' as const,
      command: { id: '1', type: 'followUp' as const, text: 'continue' },
    };
    expect(parseFrame(serializeFrame(frame))).toEqual(frame);
  });

  it('rejects arbitrary commands and oversized frames', () => {
    expect(() =>
      validateBridgeCommand({ id: 'x', type: 'exec', command: 'rm -rf /' }),
    ).toThrow();
    expect(() => parseFrame('x'.repeat(MAX_FRAME_BYTES + 1))).toThrow(/size/);
  });

  it('strictly validates each bridge event variant', () => {
    expect(
      isBridgeEvent({
        type: 'runtime.hello',
        protocolVersion: 1,
        snapshot: { runtimeId: 'r', pid: 1 },
      }),
    ).toBe(false);
    expect(
      isBridgeEvent({
        type: 'runtime.stateChanged',
        state: 'working',
        snapshot: { pid: -1 },
      }),
    ).toBe(false);
    expect(
      isBridgeEvent({
        type: 'session.changed',
        session: { id: 's', entries: [], unexpected: true },
      }),
    ).toBe(false);
    expect(
      isBridgeEvent({
        type: 'interaction.resolved',
        interactionId: 'i',
      }),
    ).toBe(false);
    expect(() =>
      parseFrame(
        JSON.stringify({
          kind: 'event',
          seq: 1,
          event: { type: 'runtime.nope' },
        }),
      ),
    ).toThrow();
  });

  it('validates structured launch requests', () => {
    expect(
      validateStartRuntimeRequest({
        workspaceId: 'w',
        model: { provider: 'p', model: 'm' },
      }).workspaceId,
    ).toBe('w');
    expect(() =>
      validateStartRuntimeRequest({ workspaceId: '../etc' }),
    ).not.toThrow();
    expect(() => validateStartRuntimeRequest({ workspaceId: '' })).toThrow();
    expect(() =>
      validateStartRuntimeRequest({
        workspaceId: 'w',
        initialPrompt: 'x'.repeat(100_001),
      }),
    ).toThrow('initial prompt');
  });
});
