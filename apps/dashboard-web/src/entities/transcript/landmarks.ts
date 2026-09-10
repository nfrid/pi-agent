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

function evenlySampleLandmarks(
  landmarks: readonly TranscriptLandmark[],
  maximum: number,
): TranscriptLandmark[] {
  if (maximum <= 0 || landmarks.length === 0) return [];
  if (landmarks.length <= maximum) return [...landmarks];
  if (maximum === 1) {
    const last = landmarks.at(-1);
    return last ? [last] : [];
  }
  const lastIndex = landmarks.length - 1;
  const sampled: TranscriptLandmark[] = [];
  for (let slot = 0; slot < maximum; slot += 1) {
    const index = Math.round((slot * lastIndex) / (maximum - 1));
    const landmark = landmarks[index];
    if (landmark && sampled.at(-1)?.key !== landmark.key)
      sampled.push(landmark);
  }
  return sampled;
}

/** Sample the drawer with a deterministic preference for user landmarks. */
export function sampleTranscriptLandmarks(
  landmarks: readonly TranscriptLandmark[],
  maximum: number,
): TranscriptLandmark[] {
  if (maximum <= 0 || landmarks.length === 0) return [];
  if (landmarks.length <= maximum) return [...landmarks];
  const users = landmarks.filter((landmark) => landmark.kind === 'user');
  const selected =
    users.length >= maximum
      ? evenlySampleLandmarks(users, maximum)
      : [
          ...users,
          ...evenlySampleLandmarks(
            landmarks.filter((landmark) => landmark.kind !== 'user'),
            maximum - users.length,
          ),
        ];
  const selectedKeys = new Set(selected.map((landmark) => landmark.key));
  return landmarks.filter((landmark) => selectedKeys.has(landmark.key));
}
