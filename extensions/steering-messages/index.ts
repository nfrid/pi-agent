import {
  type ExtensionAPI,
  type ExtensionContext,
  UserMessageComponent,
} from '@earendil-works/pi-coding-agent';
import { defineExtension } from '../shared/runtime/extension';
import { installSteeringMessageShim, type SteeringShimHost } from './shim';

export const STEERING_MESSAGE_MARKER_TYPE = 'steering-message';

export interface SteeringMessageMarker {
  timestamp: number | string;
  text: string;
}

type Timestamp = number | string;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function timestampOf(value: unknown): Timestamp | undefined {
  return typeof value === 'number' || typeof value === 'string'
    ? value
    : undefined;
}

function timestampKey(value: Timestamp): string {
  return `${typeof value}:${value}`;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).join('');
  const part = record(value);
  return typeof part?.text === 'string' ? part.text : '';
}

function userText(message: { content?: unknown }): string {
  return contentText(message.content);
}

function messageTimestamp(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): Timestamp | undefined {
  return timestampOf(message.timestamp ?? entry.timestamp);
}

function isSteeringMarker(entry: Record<string, unknown>): boolean {
  return (
    entry.type === 'custom' && entry.customType === STEERING_MESSAGE_MARKER_TYPE
  );
}

function markerData(
  entry: Record<string, unknown>,
): SteeringMessageMarker | undefined {
  if (!isSteeringMarker(entry)) return undefined;
  const data = record(entry.data);
  const timestamp = timestampOf(data?.timestamp);
  const text = data?.text;
  return timestamp === undefined || typeof text !== 'string'
    ? undefined
    : { timestamp, text };
}

function markerTimestamp(
  entry: Record<string, unknown>,
): Timestamp | undefined {
  return markerData(entry)?.timestamp;
}

interface SteeringMarks {
  historyCounts: Map<string, number>;
  marked: Map<string, Set<number>>;
}

function createMarks(): SteeringMarks {
  return { historyCounts: new Map(), marked: new Map() };
}

function addMarked(
  marked: Map<string, Set<number>>,
  text: string,
  index: number,
) {
  const occurrences = marked.get(text) ?? new Set<number>();
  occurrences.add(index);
  marked.set(text, occurrences);
}

function loadHistoryMarks(entries: readonly unknown[]): SteeringMarks {
  const marks = createMarks();
  const messagesByTimestamp = new Map<
    string,
    Array<{ text: string; occurrence: number }>
  >();
  for (const value of entries) {
    const entry = record(value);
    const message = record(entry?.message);
    if (entry?.type !== 'message' || message?.role !== 'user') continue;
    const text = contentText(message.content);
    const occurrence = marks.historyCounts.get(text) ?? 0;
    marks.historyCounts.set(text, occurrence + 1);
    const timestamp = messageTimestamp(entry, message);
    if (timestamp !== undefined) {
      const messages = messagesByTimestamp.get(timestampKey(timestamp)) ?? [];
      messages.push({ text, occurrence });
      messagesByTimestamp.set(timestampKey(timestamp), messages);
    }
  }
  for (const value of entries) {
    const entry = record(value);
    const marker = entry ? markerData(entry) : undefined;
    if (marker === undefined) continue;
    const message = messagesByTimestamp
      .get(timestampKey(marker.timestamp))
      ?.find((candidate) => candidate.text === marker.text);
    if (message) addMarked(marks.marked, message.text, message.occurrence);
  }
  return marks;
}

function takeSteeringInput(
  pending: Array<{ text: string }>,
  text: string,
): boolean {
  const exact = pending.findIndex((input) => input.text === text);
  const index = exact >= 0 ? exact : pending.length > 0 ? 0 : -1;
  if (index < 0) return false;
  pending.splice(index, 1);
  return true;
}

function tuiShimHost(
  isSteering: SteeringShimHost['isSteering'],
  context: ExtensionContext,
): SteeringShimHost {
  return {
    userComponent:
      UserMessageComponent as unknown as SteeringShimHost['userComponent'],
    isSteering,
    renderBorderCell: (text) =>
      context.ui.theme.bg(
        'userMessageBg',
        context.ui.theme.fg('warning', text),
      ),
  };
}

export function registerSteeringMessageTracking(
  pi: ExtensionAPI,
  getTuiShimHost: (
    isSteering: SteeringShimHost['isSteering'],
    context: ExtensionContext,
  ) => SteeringShimHost | undefined = tuiShimHost,
): void {
  let context: ExtensionContext | undefined;
  let marks = createMarks();
  let uninstall: (() => void) | undefined;
  const pendingSteering: Array<{ text: string }> = [];
  const liveCounts = new Map<string, number>();

  const resetSession = (nextContext: ExtensionContext): void => {
    uninstall?.();
    uninstall = undefined;
    context = nextContext;
    marks = loadHistoryMarks(nextContext.sessionManager.buildContextEntries());
    pendingSteering.length = 0;
    liveCounts.clear();
    const host =
      nextContext.mode === 'tui'
        ? getTuiShimHost(
            (text, occurrence) =>
              marks.marked.get(text)?.has(occurrence) ?? false,
            nextContext,
          )
        : undefined;
    if (host) uninstall = installSteeringMessageShim(host);
  };

  pi.on('session_start', (_event, nextContext) => {
    resetSession(nextContext);
  });
  pi.on('session_tree', (_event, nextContext) => {
    resetSession(nextContext);
  });

  pi.on('input', (event) => {
    if (event.streamingBehavior === 'steer')
      pendingSteering.push({ text: event.text });
  });

  pi.on('message_start', (event, eventContext) => {
    if (event.message.role !== 'user') return;
    const text = userText(event.message);
    const steering = takeSteeringInput(pendingSteering, text);
    const occurrence =
      (marks.historyCounts.get(text) ?? 0) + (liveCounts.get(text) ?? 0);
    liveCounts.set(text, (liveCounts.get(text) ?? 0) + 1);
    if (!steering) return;
    addMarked(marks.marked, text, occurrence);
    const timestamp = timestampOf(
      (event.message as unknown as { timestamp?: unknown }).timestamp,
    );
    if (timestamp === undefined) return;
    pi.appendEntry<SteeringMessageMarker>(STEERING_MESSAGE_MARKER_TYPE, {
      timestamp,
      text,
    });
    pi.events.emit('steering-message:marked', {
      sessionId: eventContext.sessionManager.getSessionId(),
      message: event.message,
    });
  });

  pi.on('agent_settled', () => {
    pendingSteering.length = 0;
  });

  pi.on('session_shutdown', (_event, shutdownContext) => {
    if (context !== shutdownContext) return;
    uninstall?.();
    uninstall = undefined;
    context = undefined;
    pendingSteering.length = 0;
    liveCounts.clear();
  });
}

export default defineExtension('steering-messages', (pi) => {
  registerSteeringMessageTracking(pi);
});

export { loadHistoryMarks, markerData, markerTimestamp, timestampKey };
