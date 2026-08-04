import { randomUUID } from 'node:crypto';

export interface BrokerChoice {
  label: string;
  value: string;
  description?: string;
  preview?: string;
  custom?: boolean;
}

export interface PendingInteraction {
  id: string;
  type: 'ask_user';
  question: string;
  choices: readonly BrokerChoice[];
  allowCustom: boolean;
  customLabel?: string;
  createdAt: number;
}

export type BrokerResult = {
  answer: string;
  choiceLabel?: string;
  choiceIndex?: number;
  custom: boolean;
} | null;

export type BrokerScope = object | string;
export const DEFAULT_INTERACTION_TIMEOUT_MS = 5 * 60_000;
export const MAX_INTERACTION_TIMEOUT_MS = 15 * 60_000;

type Listener = (event: {
  kind: 'requested' | 'resolved';
  interaction: PendingInteraction;
  result?: BrokerResult;
}) => void;

/**
 * A deliberately small in-process broker. The bridge and ask-user extension
 * share this singleton, so the TUI and remote client race to resolve one
 * promise rather than each owning a question.
 */
export class InteractionBroker {
  private readonly pending = new Map<
    string,
    {
      interaction: PendingInteraction;
      resolve: (result: BrokerResult) => void;
      cancelLocal?: () => void;
      scope?: BrokerScope;
      timeout?: NodeJS.Timeout;
    }
  >();
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): PendingInteraction[] {
    return [...this.pending.values()].map(({ interaction }) => interaction);
  }

  async request(
    input: Omit<PendingInteraction, 'id' | 'createdAt'>,
    presentLocal: () => Promise<BrokerResult>,
    cancelLocal?: () => void,
    scope?: BrokerScope,
    timeoutMs = DEFAULT_INTERACTION_TIMEOUT_MS,
  ): Promise<BrokerResult> {
    const interaction: PendingInteraction = {
      ...input,
      id: `ask-${randomUUID()}`,
      createdAt: Date.now(),
    };
    let resolvePromise!: (result: BrokerResult) => void;
    const promise = new Promise<BrokerResult>((resolve) => {
      resolvePromise = resolve;
    });
    const boundedTimeout = Math.min(
      Math.max(1, timeoutMs),
      MAX_INTERACTION_TIMEOUT_MS,
    );
    const timeout = setTimeout(
      () => this.cancel(interaction.id),
      boundedTimeout,
    );
    timeout.unref?.();
    this.pending.set(interaction.id, {
      interaction,
      resolve: resolvePromise,
      cancelLocal,
      scope,
      timeout,
    });
    this.emit({ kind: 'requested', interaction });
    // Promise.resolve().then also captures a presenter that throws before it
    // returns its promise, so no broker entry can remain unresolved.
    void Promise.resolve()
      .then(presentLocal)
      .then((result) => this.resolveLocal(interaction.id, result))
      .catch(() => this.resolveLocal(interaction.id, null));
    return promise;
  }

  resolve(id: string, result: BrokerResult): boolean {
    const item = this.pending.get(id);
    if (!item) return false;
    item.cancelLocal?.();
    return this.finish(id, item, result);
  }

  private resolveLocal(id: string, result: BrokerResult): boolean {
    const item = this.pending.get(id);
    if (!item) return false;
    return this.finish(id, item, result);
  }

  private finish(
    id: string,
    item: {
      interaction: PendingInteraction;
      resolve: (result: BrokerResult) => void;
      timeout?: NodeJS.Timeout;
    },
    result: BrokerResult,
  ): boolean {
    this.pending.delete(id);
    if (item.timeout) clearTimeout(item.timeout);
    item.resolve(result);
    this.emit({ kind: 'resolved', interaction: item.interaction, result });
    return true;
  }

  answer(id: string, answer: unknown): boolean {
    if (typeof answer !== 'string' || !answer.trim()) return false;
    const item = this.pending.get(id);
    if (!item) return false;
    const choiceIndex = item.interaction.choices.findIndex(
      (choice) => choice.value === answer,
    );
    const choice =
      choiceIndex >= 0 ? item.interaction.choices[choiceIndex] : undefined;
    if (!choice && !item.interaction.allowCustom) return false;
    return this.resolve(id, {
      answer,
      choiceLabel: choice?.label,
      choiceIndex: choice ? choiceIndex + 1 : undefined,
      custom: !choice,
    });
  }

  cancel(id: string): boolean {
    return this.resolve(id, null);
  }

  cancelScope(scope: BrokerScope): number {
    let cancelled = 0;
    for (const [id, item] of this.pending) {
      if (item.scope === scope && this.cancel(id)) cancelled += 1;
    }
    return cancelled;
  }

  cancelAll(): number {
    let cancelled = 0;
    for (const id of this.pending.keys()) if (this.cancel(id)) cancelled += 1;
    return cancelled;
  }

  private emit(event: {
    kind: 'requested' | 'resolved';
    interaction: PendingInteraction;
    result?: BrokerResult;
  }): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A transport observer must never break the tool's answer path.
      }
    }
  }
}

const globalKey = Symbol.for('pi.dashboard.interaction-broker');
const globalObject = globalThis as typeof globalThis & {
  [globalKey]?: InteractionBroker;
};
export function getInteractionBroker(): InteractionBroker {
  const existing = globalObject[globalKey];
  if (existing) return existing;
  const broker = new InteractionBroker();
  globalObject[globalKey] = broker;
  return broker;
}
