export const MIDTURN_COMPACTION_PATCH = Symbol.for(
  'pi.mid-run-compaction.prepare-next-turn.v1',
);
export const MIDTURN_CONTINUE_CUSTOM_TYPE = 'pi-mid-run-compaction-continue';

type ContextMessage = { role?: string };
type TurnContext = {
  messages: ContextMessage[];
  systemPrompt?: string;
  tools?: unknown[];
};
type TurnSnapshot = {
  context?: TurnContext;
  model?: unknown;
  thinkingLevel?: unknown;
};
type NextTurn = {
  context: TurnContext;
  toolResults: unknown[];
};
type AgentSessionLike = {
  agent: {
    prepareNextTurnWithContext?: (
      turn: NextTurn,
      signal?: AbortSignal,
    ) => Promise<TurnSnapshot | undefined>;
    state: {
      messages: ContextMessage[];
      model?: { contextWindow?: number };
    };
  };
  settingsManager: {
    getCompactionSettings(): { enabled: boolean; reserveTokens: number };
  };
  sessionManager: {
    getLeafId(): string | null;
    appendCustomMessageEntry(
      customType: string,
      content: unknown[],
      display: boolean,
    ): string;
    buildSessionContext(): { messages: ContextMessage[] };
    branch(entryId: string): void;
  };
  _runAutoCompaction(reason: 'threshold', willRetry: boolean): Promise<boolean>;
};
type AgentSessionConstructor = {
  prototype: AgentSessionLike & {
    _installAgentNextTurnRefresh(): void;
    [MIDTURN_COMPACTION_PATCH]?: boolean;
  };
};

export interface MidturnCompactionRuntime {
  AgentSession: AgentSessionConstructor;
  estimateContextTokens(messages: ContextMessage[]): { tokens: number };
  shouldCompact(
    contextTokens: number,
    contextWindow: number,
    settings: { enabled: boolean; reserveTokens: number },
  ): boolean;
}

export function installMidturnCompactionShim(
  runtime: MidturnCompactionRuntime,
): void {
  const prototype = runtime.AgentSession.prototype;
  if (prototype[MIDTURN_COMPACTION_PATCH]) return;

  const installNextTurnRefresh = prototype._installAgentNextTurnRefresh;
  if (typeof installNextTurnRefresh !== 'function') {
    throw new Error(
      'Unsupported Pi runtime: AgentSession._installAgentNextTurnRefresh is unavailable.',
    );
  }
  const source = Function.prototype.toString.call(installNextTurnRefresh);
  if (!source.includes('prepareNextTurnWithContext')) {
    throw new Error(
      'Unsupported Pi runtime: next-turn refresh no longer exposes the guarded callback.',
    );
  }

  prototype._installAgentNextTurnRefresh = function installCompactingRefresh(
    this: AgentSessionLike,
  ): void {
    installNextTurnRefresh.call(this);
    const prepareNextTurn = this.agent.prepareNextTurnWithContext;
    if (!prepareNextTurn) {
      throw new Error(
        'Pi did not install prepareNextTurnWithContext before the compaction shim.',
      );
    }

    this.agent.prepareNextTurnWithContext = async (turn, signal) => {
      const snapshot = await prepareNextTurn(turn, signal);
      let context = snapshot?.context ?? turn.context;
      const settings = this.settingsManager.getCompactionSettings();
      const contextWindow = this.agent.state.model?.contextWindow ?? 0;
      const contextTokens = runtime.estimateContextTokens(
        context.messages,
      ).tokens;
      if (process.env.PI_MIDTURN_COMPACTION_DEBUG === '1') {
        process.stderr.write(
          `[mid-run-compaction] tokens=${contextTokens} window=${contextWindow} reserve=${settings.reserveTokens} toolResults=${turn.toolResults.length}\n`,
        );
      }

      if (
        settings.enabled &&
        !signal?.aborted &&
        turn.toolResults.length > 0 &&
        contextWindow > 0 &&
        runtime.shouldCompact(contextTokens, contextWindow, settings)
      ) {
        const previousLeafId = this.sessionManager.getLeafId();
        if (!previousLeafId) return { ...snapshot, context };
        this.sessionManager.appendCustomMessageEntry(
          MIDTURN_CONTINUE_CUSTOM_TYPE,
          [],
          false,
        );
        this.agent.state.messages =
          this.sessionManager.buildSessionContext().messages;
        const compacted = await this._runAutoCompaction('threshold', true);
        if (process.env.PI_MIDTURN_COMPACTION_DEBUG === '1') {
          process.stderr.write(
            `[mid-run-compaction] native-compaction=${compacted ? 'completed' : 'skipped-or-failed'}\n`,
          );
        }
        if (compacted) {
          context = {
            ...context,
            messages: this.agent.state.messages,
          };
        } else {
          this.sessionManager.branch(previousLeafId);
          this.agent.state.messages =
            this.sessionManager.buildSessionContext().messages;
          context = {
            ...context,
            messages: this.agent.state.messages,
          };
        }
      }

      return { ...snapshot, context };
    };
  };

  Object.defineProperty(prototype, MIDTURN_COMPACTION_PATCH, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}
