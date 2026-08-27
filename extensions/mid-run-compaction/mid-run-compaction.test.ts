import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  installMidturnCompactionShim,
  type MidturnCompactionRuntime,
} from './runtime.js';

interface FakeContext {
  messages: Array<{ role?: string }>;
  systemPrompt?: string;
  tools?: unknown[];
}

function fakeRuntime(options: {
  tokens: number;
  compact?: () => Promise<boolean>;
}) {
  class FakeAgentSession {
    agent = {
      prepareNextTurnWithContext: undefined as
        | ((
            turn: { context: FakeContext; toolResults: unknown[] },
            signal?: AbortSignal,
          ) => Promise<{ context: FakeContext }>)
        | undefined,
      state: {
        messages: [{ role: 'assistant' }],
        model: { contextWindow: 272_000 },
      },
    };
    settingsManager = {
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384 }),
    };
    leafId = 'tool-result-leaf';
    sessionManager = {
      getLeafId: vi.fn(() => this.leafId),
      appendCustomMessageEntry: vi.fn(() => {
        this.leafId = 'continuation-marker';
        return this.leafId;
      }),
      buildSessionContext: vi.fn(() => ({
        messages:
          this.leafId === 'continuation-marker'
            ? [{ role: 'custom' }]
            : [{ role: 'toolResult' }],
      })),
      branch: vi.fn((entryId: string) => {
        this.leafId = entryId;
      }),
    };
    compact = vi.fn(options.compact ?? (async () => true));

    constructor() {
      this._installAgentNextTurnRefresh();
    }

    _installAgentNextTurnRefresh() {
      this.agent.prepareNextTurnWithContext = async (turn) => ({
        context: {
          ...turn.context,
          systemPrompt: 'refreshed',
        },
      });
    }

    async _runAutoCompaction(
      _reason: 'threshold',
      _willRetry: boolean,
    ): Promise<boolean> {
      return this.compact();
    }
  }

  const shouldCompact = vi.fn(
    (
      tokens: number,
      contextWindow: number,
      settings: { reserveTokens: number },
    ) => tokens > contextWindow - settings.reserveTokens,
  );
  const runtime = {
    AgentSession: FakeAgentSession,
    estimateContextTokens: vi.fn(() => ({ tokens: options.tokens })),
    shouldCompact,
  } as unknown as MidturnCompactionRuntime;
  installMidturnCompactionShim(runtime);
  return { FakeAgentSession, runtime, shouldCompact };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mid-run compaction runtime shim', () => {
  test('awaits native compaction and returns rebuilt messages before the next turn', async () => {
    const order: string[] = [];
    let session: InstanceType<
      ReturnType<typeof fakeRuntime>['FakeAgentSession']
    >;
    const setup = fakeRuntime({
      tokens: 260_000,
      compact: async () => {
        order.push('compact:start');
        await Promise.resolve();
        session.agent.state.messages = [{ role: 'user' }];
        order.push('compact:end');
        return true;
      },
    });
    session = new setup.FakeAgentSession();

    const snapshot = await session.agent.prepareNextTurnWithContext?.({
      context: { messages: [{ role: 'toolResult' }] },
      toolResults: [{}],
    });
    order.push('next-request');

    expect(order).toEqual(['compact:start', 'compact:end', 'next-request']);
    expect(snapshot?.context.messages).toBe(session.agent.state.messages);
    expect(snapshot?.context.systemPrompt).toBe('refreshed');
    expect(session.compact).toHaveBeenCalledOnce();
    expect(session.compact).toHaveBeenCalledWith();
    expect(
      session.sessionManager.appendCustomMessageEntry,
    ).toHaveBeenCalledWith('pi-mid-run-compaction-continue', [], false);
    expect(setup.shouldCompact).toHaveBeenCalledWith(260_000, 272_000, {
      enabled: true,
      reserveTokens: 16_384,
    });
  });

  test('uses Pi policy and skips compaction below its configured threshold', async () => {
    const { FakeAgentSession, shouldCompact } = fakeRuntime({
      tokens: 250_000,
    });
    const session = new FakeAgentSession();

    const originalMessages = [{ role: 'toolResult' }];
    const snapshot = await session.agent.prepareNextTurnWithContext?.({
      context: { messages: originalMessages },
      toolResults: [{}],
    });

    expect(shouldCompact).toHaveBeenCalledOnce();
    expect(session.compact).not.toHaveBeenCalled();
    expect(snapshot?.context.messages).toBe(originalMessages);
  });

  test('rolls back the invisible boundary when native compaction cannot run', async () => {
    const { FakeAgentSession } = fakeRuntime({
      tokens: 260_000,
      compact: async () => false,
    });
    const session = new FakeAgentSession();

    const snapshot = await session.agent.prepareNextTurnWithContext?.({
      context: { messages: [{ role: 'toolResult' }] },
      toolResults: [{}],
    });

    expect(session.sessionManager.branch).toHaveBeenCalledWith(
      'tool-result-leaf',
    );
    expect(session.leafId).toBe('tool-result-leaf');
    expect(snapshot?.context.messages).toEqual([{ role: 'toolResult' }]);
  });

  test('does not compact turns without newly completed tool results', async () => {
    const { FakeAgentSession, shouldCompact } = fakeRuntime({
      tokens: 260_000,
    });
    const session = new FakeAgentSession();

    await session.agent.prepareNextTurnWithContext?.({
      context: { messages: [{ role: 'assistant' }] },
      toolResults: [],
    });

    expect(shouldCompact).not.toHaveBeenCalled();
    expect(session.compact).not.toHaveBeenCalled();
  });

  test('installs only once per AgentSession prototype', () => {
    const setup = fakeRuntime({ tokens: 260_000 });
    const installed =
      setup.FakeAgentSession.prototype._installAgentNextTurnRefresh;

    installMidturnCompactionShim(setup.runtime);

    expect(setup.FakeAgentSession.prototype._installAgentNextTurnRefresh).toBe(
      installed,
    );
  });
});
