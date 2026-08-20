import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  cancelKeyedTurn,
  cancelKeyedTurns,
  markKeyedTurnsEntered,
  scheduleKeyedTurn,
  type TurnDeliveryMessage,
  type TurnDeliveryTiming,
} from './keyed-turn-scheduler';

export interface BackgroundDeliveryRequest {
  /** Source-local stable identity. Publishing the same key replaces its queue entry. */
  readonly key: string;
  readonly message: TurnDeliveryMessage;
  /** Default delivery reaches the next safe model boundary. */
  readonly nonObstructive?: boolean;
}

/**
 * Session-scoped facade shared by asynchronous result producers. Pi owns the
 * model boundary; this broker owns stable identities, replacement, and cancel.
 */
export class BackgroundDeliveryBroker {
  private pi?: ExtensionAPI;

  constructor(readonly scopeId: string) {}

  bind(pi: ExtensionAPI): void {
    this.pi = pi;
  }

  markEntered(messages: readonly unknown[]): void {
    markKeyedTurnsEntered(messages);
  }

  publish(request: BackgroundDeliveryRequest): string {
    if (!this.pi)
      throw new Error('Background delivery broker is not bound to Pi.');
    const key = this.scopedKey(request.key);
    const timing: TurnDeliveryTiming = request.nonObstructive
      ? 'followUp'
      : 'steer';
    scheduleKeyedTurn(this.pi, { key, timing, message: request.message });
    return key;
  }

  cancel(key: string): boolean {
    const scoped = this.scopedKey(key);
    return cancelKeyedTurn(scoped);
  }

  cancelPrefix(prefix: string): number {
    return cancelKeyedTurns(this.scopedKey(prefix));
  }

  clear(): number {
    return cancelKeyedTurns(`${this.scopeId}:`);
  }

  private scopedKey(key: string): string {
    return key.startsWith(`${this.scopeId}:`) ? key : `${this.scopeId}:${key}`;
  }
}
