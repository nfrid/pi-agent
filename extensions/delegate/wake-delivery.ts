import type { ExtensionAPI, ThemeColor } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import type { BackgroundDeliveryBroker } from '../shared/runtime/background-delivery';
import type {
  WakeAcknowledgement,
  WakeCoordinator,
  WakeDispatch,
  WakeDispatchHandler,
  WakeSnapshot,
} from './wake-coordinator';

export const DELEGATE_WAKE_MESSAGE_TYPE = 'delegate-wake-result';

export interface WakeDeliverySourcePresentation {
  readonly identity: string;
  readonly logicalId: string;
  readonly state: string;
  readonly route?: string;
  readonly durationMs?: number;
}

export interface WakeDeliveryPresentation {
  readonly origin: 'eager' | 'gate';
  readonly condition: 'node' | 'all' | 'any';
  readonly timing: 'safe' | 'idle';
  readonly sources: readonly WakeDeliverySourcePresentation[];
  readonly outstanding: readonly string[];
}

export interface WakeDeliveryDetails {
  readonly dedupeKey: string;
  readonly deliveryKey: string;
  readonly wakeId: string;
  readonly ownerSessionId: string;
  readonly ownerEpoch: number;
  readonly state: 'queued';
  readonly acknowledgement: WakeAcknowledgement;
  readonly sources: readonly string[];
  readonly presentation: WakeDeliveryPresentation;
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return '[unavailable]';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function conditionKind(
  condition: WakeSnapshot['condition'],
): 'node' | 'all' | 'any' {
  if ('all' in condition) return 'all';
  if ('any' in condition) return 'any';
  return 'node';
}

function sourcePresentation(
  identity: string,
  source: WakeDispatch['payload']['sources'][string],
): WakeDeliverySourcePresentation {
  const metadata = record(source.metadata);
  const logicalId =
    typeof metadata?.logicalId === 'string'
      ? metadata.logicalId
      : identity.replace(/@\d+$/u, '');
  const state =
    typeof metadata?.state === 'string' ? metadata.state : 'settled';
  const route =
    typeof metadata?.route === 'string' ? metadata.route : undefined;
  const startedAt =
    typeof metadata?.startedAt === 'number' ? metadata.startedAt : undefined;
  const settledAt =
    typeof metadata?.settledAt === 'number' ? metadata.settledAt : undefined;
  const durationMs =
    startedAt !== undefined && settledAt !== undefined
      ? Math.max(0, settledAt - startedAt)
      : undefined;
  return {
    identity,
    logicalId,
    state,
    ...(route ? { route } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function deliveryPresentation(
  dispatch: WakeDispatch,
  outstanding: readonly string[],
): WakeDeliveryPresentation {
  return {
    origin: dispatch.wake.id.startsWith('eager-') ? 'eager' : 'gate',
    condition: conditionKind(dispatch.wake.condition),
    timing: dispatch.wake.nonObstructive ? 'idle' : 'safe',
    sources: Object.entries(dispatch.payload.sources).map(
      ([identity, source]) => sourcePresentation(identity, source),
    ),
    outstanding: [...outstanding],
  };
}

function humanize(value: string): string {
  return value
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ');
}

function outcome(state: string): string {
  if (state === 'error') return 'failed';
  if (state === 'timed-out') return 'timed out';
  if (state === 'aborted') return 'aborted';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'blocked') return 'blocked';
  return 'finished';
}

function deliverySummary(presentation: WakeDeliveryPresentation): string {
  if (presentation.origin === 'eager')
    return presentation.timing === 'idle'
      ? 'Delivered eagerly when the parent became idle.'
      : 'Delivered eagerly at the next safe parent boundary.';
  const gate =
    presentation.condition === 'all'
      ? 'all-results gate became ready'
      : presentation.condition === 'any'
        ? 'first-result gate became ready'
        : 'requested result became ready';
  return presentation.timing === 'idle'
    ? `Delivered when the parent became idle because the ${gate}.`
    : `Delivered at the next safe parent boundary because the ${gate}.`;
}

/** Render the payload as source-grouped, model-readable evidence. */
export function formatWakeDispatch(
  dispatch: WakeDispatch,
  outstanding: readonly string[] = [],
): string {
  const presentation = deliveryPresentation(dispatch, outstanding);
  const sourceSummary =
    presentation.sources.length === 1
      ? `${humanize(presentation.sources[0]?.logicalId ?? 'delegate')} ${outcome(presentation.sources[0]?.state ?? 'settled')}`
      : `${presentation.sources.length} delegate results ready`;
  const sections = [`# ${sourceSummary}`, deliverySummary(presentation)];
  const sources = Object.entries(dispatch.payload.sources);
  for (const [identity, source] of sources) {
    const sourceDetails = presentation.sources.find(
      (candidate) => candidate.identity === identity,
    );
    sections.push(
      `\n## ${humanize(sourceDetails?.logicalId ?? identity.replace(/@\d+$/u, ''))}`,
    );
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
  if (outstanding.length > 0)
    sections.push(
      `Still running:\n${outstanding.map((item) => `- ${item}`).join('\n')}`,
    );
  return sections.join('\n\n');
}

function deliveryDetails(
  dispatch: WakeDispatch,
  outstanding: readonly string[],
): WakeDeliveryDetails {
  return {
    dedupeKey: dispatch.deliveryKey,
    deliveryKey: dispatch.deliveryKey,
    wakeId: dispatch.wake.id,
    ownerSessionId: dispatch.ownerSessionId,
    ownerEpoch: dispatch.ownerEpoch,
    state: 'queued',
    acknowledgement: dispatch.acknowledgement,
    sources: Object.keys(dispatch.payload.sources),
    presentation: deliveryPresentation(dispatch, outstanding),
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
 * Bridges the explicit wake state machine to the shared keyed delivery queue.
 * Scheduling is deliberately not treated as entry: context reconciliation is
 * the acknowledgement boundary.
 */
export function createWakeDelivery(options: {
  pi: ExtensionAPI;
  getActiveCoordinator: () => WakeCoordinator | undefined;
  getRuntimeActive: () => boolean;
  getDeliveryBroker?: () => BackgroundDeliveryBroker | undefined;
  onEntered?: (sources: readonly string[], wake: WakeSnapshot) => void;
  getOutstanding?: (sources: readonly string[]) => readonly string[];
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
    const outstanding =
      options.getOutstanding?.(Object.keys(value.payload.sources)) ?? [];
    const message = {
      customType: DELEGATE_WAKE_MESSAGE_TYPE,
      content: formatWakeDispatch(value, outstanding),
      display: true,
      details: deliveryDetails(value, outstanding),
    };
    const broker = options.getDeliveryBroker?.();
    if (broker) {
      broker.publish({
        key: `delegate-wake:${value.deliveryKey}`,
        message,
        nonObstructive: value.wake.nonObstructive,
      });
      return;
    }
    options.pi.sendMessage(message, {
      deliverAs: value.wake.nonObstructive ? 'followUp' : 'steer',
      triggerTurn: true,
    });
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
