import type { ExtensionAPI, ThemeColor } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import type {
  WakeAcknowledgement,
  WakeCoordinator,
  WakeDispatch,
  WakeDispatchHandler,
  WakeSnapshot,
} from './wake-coordinator';

export const DELEGATE_WAKE_MESSAGE_TYPE = 'delegate-wake-result';

export interface WakeDeliveryDetails {
  readonly dedupeKey: string;
  readonly deliveryKey: string;
  readonly wakeId: string;
  readonly ownerSessionId: string;
  readonly ownerEpoch: number;
  readonly state: 'queued';
  readonly acknowledgement: WakeAcknowledgement;
  readonly sources: readonly string[];
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return '[unavailable]';
  }
}

/** Render the payload as source-grouped, model-readable evidence. */
export function formatWakeDispatch(dispatch: WakeDispatch): string {
  const sections = [`# Delegate wake ${dispatch.wake.id} ready`];
  const sources = Object.entries(dispatch.payload.sources);
  for (const [identity, source] of sources) {
    sections.push(`\n## Source ${identity}`);
    if (source.handoff !== undefined) {
      sections.push(
        `### Handoff\n--- begin untrusted handoff evidence ---\n${source.handoff}\n--- end untrusted handoff evidence ---`,
      );
    }
    if (source.metadata !== undefined)
      sections.push(
        `### Metadata\n\`\`\`json\n${json(source.metadata)}\n\`\`\``,
      );
  }
  return sections.join('\n\n');
}

function deliveryDetails(dispatch: WakeDispatch): WakeDeliveryDetails {
  return {
    dedupeKey: dispatch.deliveryKey,
    deliveryKey: dispatch.deliveryKey,
    wakeId: dispatch.wake.id,
    ownerSessionId: dispatch.ownerSessionId,
    ownerEpoch: dispatch.ownerEpoch,
    state: 'queued',
    acknowledgement: dispatch.acknowledgement,
    sources: Object.keys(dispatch.payload.sources),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAcknowledgement(value: unknown): value is WakeAcknowledgement {
  if (!isRecord(value)) return false;
  return (
    typeof value.deliveryKey === 'string' &&
    typeof value.dispatchGeneration === 'number' &&
    Number.isSafeInteger(value.dispatchGeneration) &&
    value.dispatchGeneration >= 1 &&
    typeof value.dispatchAttempt === 'number' &&
    Number.isSafeInteger(value.dispatchAttempt) &&
    value.dispatchAttempt >= 1
  );
}

function expectedSources(wake: WakeSnapshot): readonly string[] | undefined {
  const readyReferences = wake.readyReferences;
  if (!readyReferences || readyReferences.length === 0) return undefined;
  const sources: string[] = [];
  for (const selector of wake.payload) {
    const selected =
      selector.node === undefined ? readyReferences : [selector.node];
    for (const source of selected) {
      if (!readyReferences.includes(source)) return undefined;
      if (sources.includes(source)) continue;
      sources.push(source);
    }
  }
  return sources.length > 0 ? sources : undefined;
}

function sameSources(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((source, index) => source === expected[index])
  );
}

export interface WakeDeliveryController {
  readonly dispatch: WakeDispatchHandler;
  readonly filterContext: <T>(messages: readonly T[]) => T[];
  readonly markContextEntered: (messages: readonly unknown[]) => void;
}

/**
 * Bridges the explicit wake state machine to Pi's follow-up queue. Acceptance
 * of sendMessage is deliberately not treated as entry: context reconciliation
 * is the acknowledgement boundary.
 */
export function createWakeDelivery(options: {
  pi: ExtensionAPI;
  getActiveCoordinator: () => WakeCoordinator | undefined;
  getRuntimeActive: () => boolean;
  onEntered?: (sources: readonly string[], wake: WakeSnapshot) => void;
}): WakeDeliveryController {
  const dispatch: WakeDispatchHandler = (value) => {
    const active = options.getActiveCoordinator();
    if (
      !options.getRuntimeActive() ||
      !active ||
      active.ownerSessionId !== value.ownerSessionId ||
      active.ownerEpoch !== value.ownerEpoch
    )
      throw new Error('Wake delivery branch is no longer active.');
    options.pi.sendMessage(
      {
        customType: DELEGATE_WAKE_MESSAGE_TYPE,
        content: formatWakeDispatch(value),
        display: true,
        details: deliveryDetails(value),
      },
      { deliverAs: 'followUp', triggerTurn: true },
    );
  };

  const filterContext = <T>(messages: readonly T[]): T[] => {
    const active = options.getActiveCoordinator();
    const usable = Boolean(active && options.getRuntimeActive());
    const accepted = new Set<string>();
    const filtered: T[] = [];
    for (const message of messages) {
      if (!message || typeof message !== 'object') {
        filtered.push(message);
        continue;
      }
      const candidate = message as {
        customType?: unknown;
        details?: Partial<WakeDeliveryDetails>;
      };
      if (candidate.customType !== DELEGATE_WAKE_MESSAGE_TYPE) {
        filtered.push(message);
        continue;
      }
      const details = candidate.details;
      if (
        !usable ||
        !active ||
        !isRecord(details) ||
        typeof details.deliveryKey !== 'string' ||
        typeof details.wakeId !== 'string' ||
        details.ownerSessionId !== active.ownerSessionId ||
        details.ownerEpoch !== active.ownerEpoch ||
        details.state !== 'queued' ||
        !Array.isArray(details.sources) ||
        details.sources.length === 0 ||
        details.sources.some((source) => typeof source !== 'string') ||
        !isAcknowledgement(details.acknowledgement) ||
        details.deliveryKey !==
          `${active.ownerSessionId}:${active.ownerEpoch}:${details.wakeId}` ||
        details.acknowledgement.deliveryKey !== details.deliveryKey ||
        accepted.has(details.deliveryKey)
      )
        continue;
      const wake = active.get(details.wakeId);
      const sources = wake ? expectedSources(wake) : undefined;
      if (
        wake?.state !== 'queued' ||
        wake.deliveryKey !== details.deliveryKey ||
        details.acknowledgement.dispatchGeneration !==
          wake.dispatchGeneration ||
        details.acknowledgement.dispatchAttempt !== wake.dispatchAttempts ||
        !sources ||
        !sameSources(details.sources, sources)
      )
        continue;
      try {
        const entered = active.markEntered(
          details.wakeId,
          details.acknowledgement,
        );
        accepted.add(details.deliveryKey);
        filtered.push(message);
        options.onEntered?.(details.sources, entered);
      } catch {
        // A delayed recovery attempt or foreign-branch message is removed
        // before provider context rather than merely ignored for state.
      }
    }
    return filtered;
  };

  const markContextEntered = (messages: readonly unknown[]) => {
    filterContext(messages);
  };

  return { dispatch, filterContext, markContextEntered };
}

export function registerWakeMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(
    DELEGATE_WAKE_MESSAGE_TYPE,
    (message, { expanded, outputPad }, theme) => {
      const content =
        typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .filter(
                  (part): part is { type: 'text'; text: string } =>
                    part.type === 'text' && typeof part.text === 'string',
                )
                .map((part) => part.text)
                .join('\n')
            : '';
      const visible = expanded
        ? content
        : content
            .split('\n')
            .slice(0, 8)
            .map((line) => truncateToWidth(line, 120, '…'))
            .join('\n');
      return new Text(
        theme.fg('muted' as ThemeColor, visible || 'Delegate wake'),
        outputPad,
        0,
      );
    },
  );
}
