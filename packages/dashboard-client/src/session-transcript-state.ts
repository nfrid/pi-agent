import {
  hydrateTranscript,
  reduceTranscriptEvent,
  type TranscriptProjection,
} from '@pi-dashboard/domain';
import type {
  AuthoritativeSessionSnapshot,
  DashboardEventEnvelope,
  SessionHistory,
} from '@pi-dashboard/protocol';

export interface SessionHistoryPageCoverage {
  start: number;
  end: number;
  hasOlder: boolean;
  nextBefore?: string;
  leadingContinuation?: boolean;
  /** IDs accounted for by this page; used to make a cap reset reloadable. */
  entryIds: readonly string[];
  entryCount: number;
  byteCount: number;
}

export interface SessionHistoryCoverage {
  serverId?: string;
  generation: number;
  runtimeEpoch?: string;
  version: SessionHistory['version'];
  /** The verified oldest contiguous range retained by the store. */
  coveredStart: number;
  coveredEnd: number;
  hasOlder: boolean;
  nextBefore?: string;
  leadingContinuation?: boolean;
  pages: readonly SessionHistoryPageCoverage[];
  pageCount: number;
  entryCount: number;
  byteCount: number;
}

/** Explicit caps keep historical pages from becoming an unbounded cache. */
export const SESSION_HISTORY_BUDGET = {
  maxPages: 32,
  maxEntries: 4096,
  maxBytes: 4 * 1024 * 1024,
} as const;

export interface LiveMessageIdentity {
  messageId: string;
  role: string;
  content: unknown;
  timestamp?: string | number;
}

export interface TranscriptOrderingState {
  generation: number;
  sequence: number;
  sequenceKnown: boolean;
}

export type TranscriptOrderingRejection = 'generation' | 'duplicate' | 'gap';

export interface TranscriptOrderingDecision {
  accepted: boolean;
  reason?: TranscriptOrderingRejection;
}

export type HistoryPageWatermarkDecision =
  | { status: 'ready'; sequence: number }
  | { status: 'ahead'; sequence: number }
  | { status: 'stale'; sequence: number }
  | { status: 'incoherent' };

export function classifyHistoryPageWatermark(
  current: TranscriptOrderingState | undefined,
  responses: readonly AuthoritativeSessionSnapshot[],
): HistoryPageWatermarkDecision {
  const first = responses[0]?.cursor;
  if (
    first === undefined ||
    responses.some((response) => response.cursor !== first)
  )
    return { status: 'incoherent' };
  if (!current) return { status: 'ready', sequence: first };
  if (!current.sequenceKnown || first > current.sequence)
    return { status: 'ahead', sequence: first };
  if (first < current.sequence) return { status: 'stale', sequence: first };
  return { status: 'ready', sequence: first };
}

export function acceptTranscriptSnapshotOrdering(
  current: TranscriptOrderingState | undefined,
  sequence: number,
  generation: number,
  authoritativeRebase = false,
): TranscriptOrderingDecision {
  if (current && current.generation !== generation)
    return { accepted: false, reason: 'generation' };
  if (
    current?.sequenceKnown === true &&
    !authoritativeRebase &&
    sequence <= current.sequence
  )
    return { accepted: false, reason: 'duplicate' };
  return { accepted: true };
}

export function acceptTranscriptEventOrdering(
  current: TranscriptOrderingState | undefined,
  sequence: number,
  generation: number,
): TranscriptOrderingDecision {
  if (current && current.generation !== generation)
    return { accepted: false, reason: 'generation' };
  if (!current?.sequenceKnown) return { accepted: true };
  if (sequence <= current.sequence)
    return { accepted: false, reason: 'duplicate' };
  if (sequence !== current.sequence + 1)
    return { accepted: false, reason: 'gap' };
  return { accepted: true };
}

function sameTranscriptValue(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function jsonByteCount(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? 0
      : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function historyPageCoverage(
  history: SessionHistory,
  entries: readonly unknown[],
  entryIds: readonly string[],
): SessionHistoryPageCoverage {
  return {
    start: history.start,
    end: history.end,
    hasOlder: history.hasOlder,
    ...(history.nextBefore === undefined
      ? {}
      : { nextBefore: history.nextBefore }),
    ...(history.leadingContinuation === undefined
      ? {}
      : { leadingContinuation: history.leadingContinuation }),
    entryIds: [...new Set(entryIds)],
    entryCount: entries.length,
    byteCount: jsonByteCount(entries),
  };
}

export function pageCoverage(
  response: AuthoritativeSessionSnapshot,
): SessionHistoryPageCoverage | undefined {
  if (!response.history) return undefined;
  const page = hydrateTranscript(response.entries, response.metadata.id, {
    fallbackEntryIds: true,
    fallbackEntryOffset: response.history.start,
  });
  return historyPageCoverage(response.history, response.entries, page.order);
}

export function historyFromPages(
  pages: readonly SessionHistoryPageCoverage[],
): SessionHistory | undefined {
  const oldest = pages[0];
  const newest = pages.at(-1);
  if (!oldest || !newest) return undefined;
  return {
    version: 1,
    start: oldest.start,
    end: newest.end,
    hasOlder: oldest.hasOlder,
    ...(oldest.nextBefore === undefined
      ? {}
      : { nextBefore: oldest.nextBefore }),
    ...(oldest.leadingContinuation === true && oldest.hasOlder
      ? { leadingContinuation: true }
      : {}),
  };
}

export function coverageWithPages(
  pages: readonly SessionHistoryPageCoverage[],
  generation: number,
  serverId: string | undefined,
  runtimeEpoch: string | undefined,
): SessionHistoryCoverage | undefined {
  const history = historyFromPages(pages);
  if (!history) return undefined;
  return {
    ...(serverId === undefined ? {} : { serverId }),
    generation,
    ...(runtimeEpoch === undefined ? {} : { runtimeEpoch }),
    version: history.version,
    coveredStart: history.start,
    coveredEnd: history.end,
    hasOlder: history.hasOlder,
    ...(history.nextBefore === undefined
      ? {}
      : { nextBefore: history.nextBefore }),
    ...(history.leadingContinuation === undefined
      ? {}
      : { leadingContinuation: history.leadingContinuation }),
    pages,
    pageCount: pages.length,
    entryCount: pages.reduce((total, page) => total + page.entryCount, 0),
    byteCount: pages.reduce((total, page) => total + page.byteCount, 0),
  };
}

export interface InstallAuthoritativeTranscriptInput {
  response: AuthoritativeSessionSnapshot;
  previousProjection?: TranscriptProjection;
  previousCoverage?: SessionHistoryCoverage;
  generation: number;
  serverId?: string;
  coveredCursor: number;
  replace?: boolean;
}

export interface InstallAuthoritativeTranscriptResult {
  projection: TranscriptProjection;
  coverage?: SessionHistoryCoverage;
  activeIsCurrent: boolean;
}

export function installAuthoritativeTranscript({
  response,
  previousProjection,
  previousCoverage,
  generation,
  serverId,
  coveredCursor,
  replace = false,
}: InstallAuthoritativeTranscriptInput): InstallAuthoritativeTranscriptResult {
  const currentProjection = replace ? undefined : previousProjection;
  const baselineRuntimeSeq = response.runtimeSeq;
  let projection = hydrateTranscript(response.entries, response.metadata.id, {
    fallbackEntryIds: true,
    fallbackEntryOffset: response.history?.start ?? 0,
    cursor: coveredCursor,
    ...(response.runtimeEpoch === undefined
      ? {}
      : { runtimeEpoch: response.runtimeEpoch }),
    ...(baselineRuntimeSeq === undefined
      ? {}
      : { runtimeSeq: baselineRuntimeSeq }),
  });

  const active = response.active;
  const activeEpoch = active?.runtimeEpoch ?? response.runtimeEpoch;
  const activeIsCurrent =
    active !== undefined &&
    (!currentProjection ||
      response.cursor === undefined ||
      response.cursor >= currentProjection.lastCursor) &&
    (activeEpoch === undefined ||
      currentProjection?.runtimeEpoch === undefined ||
      activeEpoch === currentProjection.runtimeEpoch) &&
    (active.runtimeSeq === undefined ||
      currentProjection?.runtimeEpoch !== activeEpoch ||
      (currentProjection?.lastRuntimeSeq ?? -1) <= active.runtimeSeq);
  if (activeIsCurrent && active) {
    const reducerInput = (event: unknown) =>
      ({
        event,
        runtimeEpoch: activeEpoch,
        sessionId: response.metadata.id,
      }) as DashboardEventEnvelope;
    const persistedProjection = projection;
    for (const message of active.messages) {
      if (persistedMessageIdForLive(persistedProjection, message) !== undefined)
        continue;
      projection = reduceTranscriptEvent(
        projection,
        reducerInput({
          type: 'message.updated',
          sessionId: response.metadata.id,
          message,
        }),
      );
    }
    for (const tool of active.tools)
      projection = reduceTranscriptEvent(
        projection,
        reducerInput({
          type: 'tool.updated',
          sessionId: response.metadata.id,
          tool,
        }),
      );
  }

  const retiredEpochs = new Set([
    ...projection.retiredEpochs,
    ...(previousProjection?.retiredEpochs ?? []),
  ]);
  if (
    previousProjection?.runtimeEpoch !== undefined &&
    previousProjection.runtimeEpoch !== projection.runtimeEpoch
  )
    retiredEpochs.add(previousProjection.runtimeEpoch);
  const responseRuntimeSeq =
    response.runtimeEpoch !== undefined &&
    response.runtimeEpoch === projection.runtimeEpoch
      ? (response.runtimeSeq ?? -1)
      : -1;
  const currentRuntimeSeq =
    currentProjection?.runtimeEpoch !== undefined &&
    currentProjection.runtimeEpoch === projection.runtimeEpoch
      ? currentProjection.lastRuntimeSeq
      : -1;
  projection = {
    ...projection,
    ...(projection.runtimeEpoch === undefined &&
    currentProjection?.runtimeEpoch !== undefined
      ? { runtimeEpoch: currentProjection.runtimeEpoch }
      : {}),
    lastCursor: Math.max(
      projection.lastCursor,
      coveredCursor,
      currentProjection?.lastCursor ?? -1,
    ),
    lastRuntimeSeq: Math.max(
      projection.lastRuntimeSeq,
      responseRuntimeSeq,
      currentRuntimeSeq,
    ),
    retiredEpochs: [...retiredEpochs],
  };

  const responseRuntimeMatches =
    response.runtimeEpoch === undefined ||
    response.runtimeEpoch === currentProjection?.runtimeEpoch;
  if (
    response.entriesComplete === false &&
    currentProjection &&
    responseRuntimeMatches
  ) {
    if (hasUserTranscriptMessage(currentProjection)) {
      projection = {
        ...currentProjection,
        lastCursor: Math.max(currentProjection.lastCursor, coveredCursor),
        lastRuntimeSeq: Math.max(
          currentProjection.lastRuntimeSeq,
          response.runtimeSeq ?? -1,
        ),
        retiredEpochs: [...retiredEpochs],
      };
    } else {
      const merged = mergePrependedTranscript(currentProjection, projection);
      projection = { ...projection, order: merged.order, items: merged.items };
    }
  }

  const responsePage = pageCoverage(response);
  let nextCoverage: SessionHistoryCoverage | undefined;
  let retainVerifiedCoverage = false;
  if (responsePage) {
    const responseServerId = response.serverId ?? serverId;
    const responseEpoch = response.runtimeEpoch;
    if (previousCoverage) {
      const newestPage = previousCoverage.pages.at(-1);
      const explicitRuntimeMismatch =
        previousCoverage.runtimeEpoch !== undefined &&
        responseEpoch !== undefined &&
        previousCoverage.runtimeEpoch !== responseEpoch;
      const sameIdentity =
        previousCoverage.generation === generation &&
        previousCoverage.serverId === responseServerId &&
        !explicitRuntimeMismatch;
      const contiguousLatestWindow =
        newestPage !== undefined &&
        responsePage.start <= newestPage.start &&
        responsePage.end >= newestPage.start &&
        responsePage.end >= previousCoverage.coveredEnd;
      const rewrite =
        response.cursor !== undefined &&
        previousProjection !== undefined &&
        response.cursor <= previousProjection.lastCursor &&
        (!sameAuthoritativePage(
          newestProjection(previousProjection, previousCoverage),
          response,
        ) ||
          !sameTranscriptProjection(
            newestProjection(previousProjection, previousCoverage),
            projection,
          ));
      retainVerifiedCoverage =
        sameIdentity && contiguousLatestWindow && !rewrite;
      if (retainVerifiedCoverage) {
        const pages = [...previousCoverage.pages];
        pages[pages.length - 1] = responsePage;
        nextCoverage = coverageWithPages(
          pages,
          generation,
          responseServerId,
          responseEpoch ?? previousCoverage.runtimeEpoch,
        );
      }
    }
    if (!nextCoverage)
      nextCoverage = coverageWithPages(
        [responsePage],
        generation,
        responseServerId,
        responseEpoch,
      );
  }
  if (retainVerifiedCoverage && previousProjection && previousCoverage)
    projection = mergeLatestTranscript(
      previousProjection,
      projection,
      previousCoverage,
      responsePage?.entryIds ?? [],
    );

  return {
    projection: reuseTranscriptProjection(previousProjection, projection),
    ...(nextCoverage === undefined ? {} : { coverage: nextCoverage }),
    activeIsCurrent,
  };
}

export function mergeLatestTranscript(
  retained: TranscriptProjection,
  latest: TranscriptProjection,
  coverage: SessionHistoryCoverage,
  latestPersistedIds: readonly string[],
): TranscriptProjection {
  const newestPageIds = new Set(coverage.pages.at(-1)?.entryIds ?? []);
  const allHistoryIds = new Set(
    coverage.pages.flatMap((page) => page.entryIds),
  );
  const latestIds = new Set(latest.order);
  const retainedHistory = retained.order.filter(
    (id) =>
      allHistoryIds.has(id) && !newestPageIds.has(id) && !latestIds.has(id),
  );
  const retainedIds = new Set(retained.order);
  const persistedMessageCounts = new Map<string, number>();
  for (const id of latestPersistedIds) {
    if (retainedIds.has(id)) continue;
    const item = latest.items[id];
    if (item?.kind !== 'message') continue;
    const key = messageSemanticKey(item);
    if (key !== undefined)
      persistedMessageCounts.set(
        key,
        (persistedMessageCounts.get(key) ?? 0) + 1,
      );
  }
  const retainedLive = retained.order.filter((id) => {
    if (allHistoryIds.has(id) || latestIds.has(id)) return false;
    const item = retained.items[id];
    if (item?.kind !== 'message') return true;
    const key = messageSemanticKey(item);
    if (key === undefined) return true;
    const count = persistedMessageCounts.get(key) ?? 0;
    if (count === 0) return true;
    persistedMessageCounts.set(key, count - 1);
    return false;
  });
  const retainedOrder = [...retainedHistory, ...retainedLive];
  const items: Record<string, TranscriptProjection['items'][string]> = {};
  for (const id of retainedOrder) {
    const item = retained.items[id];
    if (item) items[id] = item;
  }
  for (const [id, item] of Object.entries(latest.items)) items[id] = item;
  return {
    ...latest,
    order: [...retainedHistory, ...latest.order, ...retainedLive],
    items,
  };
}

export function newestProjection(
  current: TranscriptProjection,
  coverage: SessionHistoryCoverage,
): TranscriptProjection {
  const newest = coverage.pages.at(-1);
  if (!newest) return current;
  const allHistoryIds = new Set(
    coverage.pages.flatMap((page) => page.entryIds),
  );
  const newestIds = new Set(newest.entryIds);
  const order = current.order.filter(
    (id) => newestIds.has(id) || !allHistoryIds.has(id),
  );
  const items = Object.fromEntries(
    order.flatMap((id) => {
      const item = current.items[id];
      return item ? [[id, item] as const] : [];
    }),
  );
  return { ...current, order, items };
}

export function sameTranscriptProjection(
  left: TranscriptProjection,
  right: TranscriptProjection,
): boolean {
  return (
    left.order.length === right.order.length &&
    left.order.every(
      (id, index) =>
        id === right.order[index] &&
        sameTranscriptValue(left.items[id], right.items[id]),
    )
  );
}

export function sameAuthoritativePage(
  current: TranscriptProjection,
  response: AuthoritativeSessionSnapshot,
): boolean {
  if (!response.history) return false;
  const page = hydrateTranscript(response.entries, response.metadata.id, {
    fallbackEntryIds: true,
    fallbackEntryOffset: response.history.start,
  });
  return (
    page.order.length === page.order.filter((id) => current.items[id]).length &&
    page.order.every((id) =>
      sameTranscriptValue(page.items[id], current.items[id]),
    )
  );
}

export function reuseTranscriptProjection(
  previous: TranscriptProjection | undefined,
  next: TranscriptProjection,
): TranscriptProjection {
  if (!previous) return next;
  const items = { ...next.items };
  for (const [id, item] of Object.entries(next.items)) {
    const prior = previous.items[id];
    if (prior && sameTranscriptValue(prior, item)) items[id] = prior;
  }
  const orderIsSame =
    previous.order.length === next.order.length &&
    previous.order.every((id, index) => next.order[index] === id);
  const itemIds = Object.keys(items);
  const previousItemIds = Object.keys(previous.items);
  const itemsAreSame =
    itemIds.length === previousItemIds.length &&
    itemIds.every((id) => items[id] === previous.items[id]);
  return {
    ...next,
    ...(orderIsSame ? { order: previous.order } : {}),
    ...(itemsAreSame ? { items: previous.items } : { items }),
  };
}

export function liveMessageIdentity(
  envelope: DashboardEventEnvelope,
): LiveMessageIdentity | undefined {
  const event = envelope.event;
  if (
    event.type !== 'message.started' &&
    event.type !== 'message.updated' &&
    event.type !== 'message.finished'
  )
    return undefined;
  if (!event.message || typeof event.message !== 'object') return undefined;
  const message = event.message as Record<string, unknown>;
  if (typeof message.messageId !== 'string' || typeof message.role !== 'string')
    return undefined;
  const timestamp = message.timestamp;
  return {
    messageId: message.messageId,
    role: message.role,
    content: message.content,
    ...((typeof timestamp === 'string' && timestamp.length > 0) ||
    (typeof timestamp === 'number' && Number.isFinite(timestamp))
      ? { timestamp }
      : {}),
  };
}

function messageContentKey(value: unknown): string | undefined {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    return input;
  };
  try {
    return JSON.stringify(normalize(value));
  } catch {
    return undefined;
  }
}

function messageSemanticKey(
  message: Pick<LiveMessageIdentity, 'role' | 'content' | 'timestamp'>,
): string | undefined {
  if (message.timestamp === undefined) return undefined;
  const content = messageContentKey(message.content);
  return content === undefined
    ? undefined
    : JSON.stringify([message.role, String(message.timestamp), content]);
}

export function persistedMessageIdForLive(
  projection: TranscriptProjection,
  live: LiveMessageIdentity | undefined,
): string | undefined {
  if (!live) return undefined;
  const liveKey = messageSemanticKey(live);
  if (liveKey === undefined) return undefined;
  let matchedId: string | undefined;
  for (const item of Object.values(projection.items)) {
    if (
      item.kind !== 'message' ||
      item.messageId === live.messageId ||
      messageSemanticKey(item) !== liveKey
    )
      continue;
    if (matchedId !== undefined) return undefined;
    matchedId = item.messageId;
  }
  return matchedId;
}

export function mergePrependedTranscript(
  current: TranscriptProjection,
  older: TranscriptProjection,
): TranscriptProjection {
  const duplicateLiveMessageIds = new Set<string>();
  for (const id of current.order) {
    const item = current.items[id];
    if (
      item?.kind === 'message' &&
      persistedMessageIdForLive(older, item) !== undefined
    )
      duplicateLiveMessageIds.add(id);
  }
  const items: Record<string, TranscriptProjection['items'][string]> = {
    ...older.items,
  };
  for (const [id, item] of Object.entries(current.items)) {
    if (duplicateLiveMessageIds.has(id)) continue;
    const previous = items[id];
    if (previous?.kind === 'tool' && item.kind === 'tool') {
      items[id] = {
        ...previous,
        ...item,
        name:
          item.name === 'tool' && previous.name !== 'tool'
            ? previous.name
            : item.name,
        ...(item.arguments === undefined && previous.arguments !== undefined
          ? { arguments: previous.arguments }
          : {}),
        ...(item.result === undefined && previous.result !== undefined
          ? { result: previous.result }
          : {}),
        ...(item.isError === undefined && previous.isError !== undefined
          ? { isError: previous.isError }
          : {}),
        ...(item.data === undefined && previous.data !== undefined
          ? { data: previous.data }
          : {}),
      };
    } else items[id] = item;
  }
  const olderIds = new Set(older.order);
  return {
    ...current,
    order: [
      ...older.order,
      ...current.order.filter(
        (id) => !olderIds.has(id) && !duplicateLiveMessageIds.has(id),
      ),
    ],
    items,
  };
}

export function reduceSessionTranscriptEvent(
  current: TranscriptProjection | undefined,
  sessionId: string,
  envelope: DashboardEventEnvelope,
): TranscriptProjection | undefined {
  const canSeedSnapshot =
    envelope.event.type === 'session.snapshot' &&
    (envelope.event.session as { entriesComplete?: boolean })
      .entriesComplete === true;
  const base =
    current ?? (canSeedSnapshot ? hydrateTranscript([], sessionId) : undefined);
  if (!base) return undefined;
  const liveMessage = liveMessageIdentity(envelope);
  const persistedMessageId =
    envelope.event.type === 'message.finished'
      ? persistedMessageIdForLive(base, liveMessage)
      : undefined;
  return persistedMessageId && liveMessage
    ? withoutTranscriptMessage(base, liveMessage.messageId)
    : reduceTranscriptEvent(base, envelope);
}

export function hasUserTranscriptMessage(
  projection: TranscriptProjection,
): boolean {
  return Object.values(projection.items).some(
    (item) => item.kind === 'message' && item.role === 'user',
  );
}

export function withoutTranscriptMessage(
  projection: TranscriptProjection,
  messageId: string,
): TranscriptProjection {
  if (!projection.items[messageId]) return projection;
  const items = { ...projection.items };
  delete items[messageId];
  return {
    ...projection,
    items,
    order: projection.order.filter((id) => id !== messageId),
  };
}
