import type { SessionOutlineLandmark } from '@pi-dashboard/protocol';
import type { TranscriptModelItem } from '../../transcript';
export type TranscriptLandmark = {
  key: string;
  label: string;
  kind: 'user' | 'assistant';
  itemIndex: number;
  deliveryMode?: 'steer' | 'followUp';
  timestamp?: number | string;
  typeLabel?: string;
  variant?: string;
};

function landmarkLabel(item: TranscriptModelItem, fallback: string): string {
  const text = item.text?.replace(/\s+/gu, ' ').trim();
  const label = text
    ? text.length > 240
      ? `${text.slice(0, 239)}…`
      : text
    : item.preparing
      ? 'Preparing response'
      : item.entry.kind === 'assistant' && item.entry.title
        ? item.entry.title
        : fallback;
  return item.deliveryMode === 'steer' ? `Steering · ${label}` : label;
}

export function transcriptItemTimestamp(
  item: TranscriptModelItem,
): number | string | undefined {
  const raw =
    item.raw && typeof item.raw === 'object'
      ? (item.raw as Record<string, unknown>)
      : undefined;
  const message =
    raw?.message && typeof raw.message === 'object'
      ? (raw.message as Record<string, unknown>)
      : undefined;
  const data =
    raw?.data && typeof raw.data === 'object'
      ? (raw.data as Record<string, unknown>)
      : undefined;
  const timestamp = message?.timestamp ?? raw?.timestamp ?? data?.timestamp;
  return typeof timestamp === 'number' || typeof timestamp === 'string'
    ? timestamp
    : undefined;
}

export function transcriptRoleLabel(
  role: 'user' | 'assistant',
  deliveryMode?: TranscriptModelItem['deliveryMode'],
): string {
  if (deliveryMode === 'steer') return 'steer';
  return role === 'assistant' ? 'agent' : role;
}

export function buildTranscriptLandmarks(
  items: readonly TranscriptModelItem[],
): TranscriptLandmark[] {
  const result: TranscriptLandmark[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    if (item.role === 'user')
      result.push({
        key: item.key,
        label: item.landmark?.label ?? landmarkLabel(item, 'User turn'),
        kind: 'user',
        itemIndex: index,
        ...(item.landmark?.typeLabel === undefined
          ? {}
          : { typeLabel: item.landmark.typeLabel }),
        ...(item.landmark?.variant === undefined
          ? {}
          : { variant: item.landmark.variant }),
        ...(item.deliveryMode === undefined
          ? {}
          : { deliveryMode: item.deliveryMode }),
        ...(transcriptItemTimestamp(item) === undefined
          ? {}
          : { timestamp: transcriptItemTimestamp(item) }),
      });
    else if (
      item.role === 'assistant' &&
      item.entry.kind === 'assistant' &&
      item.entry.titleKind === 'preamble'
    )
      result.push({
        key: item.key,
        label: landmarkLabel(item, 'Assistant message'),
        kind: 'assistant',
        itemIndex: index,
        ...(transcriptItemTimestamp(item) === undefined
          ? {}
          : { timestamp: transcriptItemTimestamp(item) }),
      });
  }
  return result;
}

/** The outline is intentionally user-turn-only; other consumers retain all raw landmarks. */
export function selectTranscriptUserTurns(
  landmarks: readonly TranscriptLandmark[],
): TranscriptLandmark[] {
  return landmarks.filter((landmark) => landmark.kind === 'user');
}

/**
 * Resolve the user turn represented by the first visible model item.
 *
 * `currentItemIndex` is local to `loadedLandmarks`; the complete outline's
 * ordinal is a raw-history position. Use the loaded key/index relation first,
 * then use the complete outline only when the visible item is itself an
 * outline landmark (for example an assistant preamble). This keeps the two
 * index spaces from being compared.
 */
export function currentTranscriptUserTurnKey(
  landmarks: readonly TranscriptLandmark[],
  loadedLandmarks: readonly TranscriptLandmark[],
  currentItemKey?: string,
  currentItemIndex?: number,
): string | undefined {
  if (currentItemIndex !== undefined) {
    const loadedTurn = selectTranscriptUserTurns(loadedLandmarks)
      .filter((landmark) => landmark.itemIndex <= currentItemIndex)
      .at(-1);
    if (loadedTurn) return loadedTurn.key;
  }
  if (currentItemKey === undefined) return undefined;
  const landmarkIndex = landmarks.findIndex(
    (landmark) =>
      landmark.key === currentItemKey ||
      landmark.key === `group-${currentItemKey}`,
  );
  if (landmarkIndex < 0) return undefined;
  return selectTranscriptUserTurns(landmarks.slice(0, landmarkIndex + 1)).at(-1)
    ?.key;
}

export type TranscriptLandmarkCluster = {
  key: string;
  landmarks: readonly TranscriptLandmark[];
  representative: TranscriptLandmark;
};

/** Group contiguous user turns when the bounded rail cannot show each anchor. */
export function clusterTranscriptUserTurns(
  landmarks: readonly TranscriptLandmark[],
  maximum: number,
): TranscriptLandmarkCluster[] {
  const turns = selectTranscriptUserTurns(landmarks);
  if (maximum <= 0 || turns.length === 0) return [];
  if (turns.length <= maximum)
    return turns.map((landmark) => ({
      key: landmark.key,
      landmarks: [landmark],
      representative: landmark,
    }));
  const size = Math.ceil(turns.length / maximum);
  const clusters: TranscriptLandmarkCluster[] = [];
  for (let start = 0; start < turns.length; start += size) {
    const group = turns.slice(start, start + size);
    const first = group[0];
    if (!first) continue;
    clusters.push({
      key: `turn-cluster-${first.key}`,
      landmarks: group,
      representative: first,
    });
  }
  return clusters;
}

export function mergeTranscriptLandmarks(
  loadedLandmarks: readonly TranscriptLandmark[],
  outline: readonly SessionOutlineLandmark[] | undefined,
): TranscriptLandmark[] {
  if (outline === undefined) return [...loadedLandmarks];
  const matchedLoadedKeys = new Set<string>();
  const merged = outline.map((landmark) => {
    const loaded = loadedLandmarks.find(
      (candidate) =>
        candidate.key === landmark.id ||
        candidate.key === `group-${landmark.id}`,
    );
    if (loaded) {
      matchedLoadedKeys.add(loaded.key);
      return {
        ...loaded,
        label: loaded.variant ? loaded.label : landmark.label,
      };
    }
    return {
      key: landmark.id,
      label: landmark.label,
      kind: landmark.kind === 'activity' ? 'assistant' : landmark.kind,
      itemIndex: landmark.ordinal,
      ...(landmark.timestamp === undefined
        ? {}
        : { timestamp: landmark.timestamp }),
    };
  });
  return [
    ...merged,
    ...loadedLandmarks.filter(
      (landmark) => !matchedLoadedKeys.has(landmark.key),
    ),
  ];
}
