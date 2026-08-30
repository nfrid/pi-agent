import {
  isActionAvailable,
  type RuntimeCapabilitySnapshot,
} from '@pi-dashboard/extension-contributions';
import type {
  BrowserSnapshot,
  RuntimeSnapshot,
  SessionThreadLink,
  Thread,
} from '@pi-dashboard/protocol';
import Fuse, { type FuseResultMatch } from 'fuse.js';
import { sessionDisplayTitle } from '../../app-helpers';
import {
  agentThreadRows,
  isArchivedThread,
  statusGlyph,
  statusLabel,
} from '../agent-thread-nav/model';

export function actionNeedsInput(action: { inputSchema?: unknown }): boolean {
  const schema = action.inputSchema;
  // Older manifests omitted inputSchema for actions that accept {}. Treat an
  // absent schema, and an explicitly empty object schema, as inputless.
  if (schema === undefined || schema === null) return false;
  if (typeof schema !== 'object' || Array.isArray(schema)) return true;
  const value = schema as { required?: unknown; minProperties?: unknown };
  return (
    (Array.isArray(value.required) && value.required.length > 0) ||
    (typeof value.minProperties === 'number' && value.minProperties > 0)
  );
}

export type PaletteGroup = 'Actions' | 'Navigation' | 'Threads' | 'Projects';
export type PaletteMatchRange = readonly [start: number, end: number];
export type PaletteVisibleField = 'title' | 'description' | 'meta';

interface PaletteItemBase {
  id: string;
  group: PaletteGroup;
  title: string;
  description: string;
  meta?: string;
  keywords: readonly string[];
  icon: string;
  thread?: {
    lifecycle: 'active' | 'settled' | 'archived';
    status: string;
    statusTone: string;
    project: string;
    checkout: string;
    checkoutKind: 'main' | 'worktree' | 'external';
    checkoutPath?: string;
    activityAt: number;
    createdAt: number;
  };
  threadOrder?: {
    lifecycle: number;
    updatedAt: number;
    createdAt: number;
  };
  contextual?: boolean;
}

export type PaletteItem =
  | (PaletteItemBase & {
      kind: 'navigate';
      path: string;
    })
  | (PaletteItemBase & {
      kind: 'surface';
      surface: 'new-thread-project';
    })
  | (PaletteItemBase & {
      kind: 'action';
      runtime: RuntimeSnapshot;
      action: ReturnType<typeof snapshotActions>[number]['action'];
      needsInput: boolean;
    });

export type PaletteSearchResult = {
  item: PaletteItem;
  matches: Partial<Record<PaletteVisibleField, readonly PaletteMatchRange[]>>;
};

// Keep the queryless palette compact without limiting the searchable thread
// catalogue.
const MAX_PALETTE_PROJECTS = 24;
const RECENT_PALETTE_THREADS = 12;

function snapshotActions(snapshot: BrowserSnapshot) {
  return snapshot.runtimes.flatMap((runtime) =>
    runtime.online === false
      ? []
      : (runtime.capabilities?.manifests ?? []).flatMap((manifest) =>
          manifest.actions
            .filter(
              (action) =>
                action.id !== 'activity-groups.set' &&
                isActionAvailable(
                  action,
                  runtime.capabilities as RuntimeCapabilitySnapshot | undefined,
                  {
                    online: runtime.online !== false,
                    liveState: runtime.liveState,
                  },
                ),
            )
            .map((action) => ({ runtime, action })),
        ),
  );
}

export function paletteItems(
  snapshot: BrowserSnapshot,
  durableThreads?: readonly Thread[],
  directLinks: readonly SessionThreadLink[] = [],
  currentSessionId?: string,
): PaletteItem[] {
  const primary: PaletteItem[] = [
    {
      kind: 'surface',
      id: 'new-thread',
      group: 'Actions',
      title: 'New thread',
      description: 'Choose a project and start a new thread',
      keywords: ['create', 'chat', 'agent', 'start'],
      icon: '+',
      surface: 'new-thread-project',
    },
    {
      kind: 'navigate',
      id: 'dashboard',
      group: 'Navigation',
      title: 'Dashboard',
      description: 'Go to the operational overview',
      keywords: ['home', 'overview', 'runtimes'],
      icon: '⌂',
      path: '/',
    },
    {
      kind: 'navigate',
      id: 'projects',
      group: 'Navigation',
      title: 'Projects',
      description: 'Browse registered projects',
      keywords: ['repositories', 'workspaces', 'folders'],
      icon: '◇',
      path: '/projects',
    },
  ];
  const actions = snapshotActions(snapshot).map(
    ({ runtime, action }): PaletteItem => ({
      kind: 'action',
      id: `action:${runtime.runtimeId}:${action.id}`,
      group: 'Actions',
      title: action.title ?? action.id,
      description: action.description ?? action.id,
      meta: `${sessionDisplayTitle(runtime.session, runtime.session.entries)} · ${runtime.cwd}`,
      keywords: [action.id, runtime.runtimeId],
      icon: '›',
      runtime,
      action,
      needsInput: actionNeedsInput(action),
      contextual: runtime.session.id === currentSessionId,
    }),
  );
  const threadsById = new Map(
    durableThreads?.map((thread) => [thread.id, thread]) ?? [],
  );
  const threads = agentThreadRows(snapshot, durableThreads, directLinks)
    .filter((row) => row.session || row.runtime)
    .map((row): PaletteItem => {
      const durableThread = row.durableThread
        ? threadsById.get(row.durableThread.threadId)
        : undefined;
      const lifecycle =
        isArchivedThread(row) || durableThread?.archivedAt !== undefined
          ? 'archived'
          : row.durableThread?.settledAt !== undefined ||
              durableThread?.settledAt !== undefined
            ? 'settled'
            : 'active';
      const checkoutId =
        row.runtime?.checkoutId ??
        row.durableThread?.checkoutId ??
        row.session?.checkoutId ??
        durableThread?.checkoutId;
      const checkout = (snapshot.checkouts ?? []).find(
        (candidate) => candidate.id === checkoutId,
      );
      const checkoutKind = checkout?.kind ?? 'main';
      const checkoutLabel = checkout?.branch ?? checkoutKind;
      const displayStatus =
        lifecycle === 'active' ? statusLabel(row) : lifecycle;
      const activityAt = Math.max(
        row.updatedAt ?? 0,
        durableThread?.updatedAt ?? 0,
      );
      const createdAt = durableThread?.createdAt ?? row.startedAt ?? 0;
      return {
        kind: 'navigate',
        id: `session:${row.id}`,
        group: 'Threads',
        title: row.title,
        description: `${row.projectName} / ${checkoutLabel}`,
        meta: displayStatus,
        keywords: [
          'session',
          'thread',
          row.id,
          row.projectName,
          row.cwd,
          checkoutLabel,
          checkoutKind,
          checkout?.path ?? '',
          displayStatus,
          lifecycle,
        ],
        icon:
          lifecycle === 'archived'
            ? '□'
            : lifecycle === 'settled'
              ? '○'
              : statusGlyph(row.status),
        path: `/sessions/${encodeURIComponent(row.id)}`,
        thread: {
          lifecycle,
          status: displayStatus,
          statusTone: row.status,
          project: row.projectName,
          checkout: checkoutLabel,
          checkoutKind,
          ...(checkout?.path ? { checkoutPath: checkout.path } : {}),
          activityAt,
          createdAt,
        },
        threadOrder: {
          lifecycle:
            lifecycle === 'active' ? 0 : lifecycle === 'settled' ? 1 : 2,
          updatedAt: activityAt,
          createdAt,
        },
      };
    })
    .sort(compareThreadItems);
  const projects = (snapshot.projects ?? []).slice(0, MAX_PALETTE_PROJECTS).map(
    (project): PaletteItem => ({
      kind: 'navigate',
      id: `project:${project.id}`,
      group: 'Projects',
      title: project.title,
      description: project.rootPath,
      keywords: ['project', 'repository', project.id],
      icon: '◇',
      path: `/projects/${encodeURIComponent(project.id)}`,
    }),
  );
  return [...primary, ...actions, ...threads, ...projects];
}

function compareThreadItems(left: PaletteItem, right: PaletteItem): number {
  const leftOrder = left.threadOrder;
  const rightOrder = right.threadOrder;
  if (!leftOrder || !rightOrder) return 0;
  return (
    leftOrder.lifecycle - rightOrder.lifecycle ||
    rightOrder.updatedAt - leftOrder.updatedAt ||
    rightOrder.createdAt - leftOrder.createdAt ||
    left.title.localeCompare(right.title)
  );
}

function orderThreadResults(
  results: readonly PaletteSearchResult[],
): PaletteSearchResult[] {
  const threadResults = results
    .filter((result) => result.item.group === 'Threads')
    .sort((left, right) => compareThreadItems(left.item, right.item));
  let threadIndex = 0;
  return results.map((result) =>
    result.item.group === 'Threads'
      ? (threadResults[threadIndex++] ?? result)
      : result,
  );
}

function visibleMatches(
  matches: readonly FuseResultMatch[] | undefined,
): PaletteSearchResult['matches'] {
  const result: PaletteSearchResult['matches'] = {};
  for (const match of matches ?? []) {
    if (
      match.key !== 'title' &&
      match.key !== 'description' &&
      match.key !== 'meta'
    )
      continue;
    result[match.key] = match.indices;
  }
  return result;
}

function literalRanges(text: string | undefined, query: string) {
  if (!text) return undefined;
  const index = text.toLocaleLowerCase().indexOf(query);
  return index < 0 ? undefined : ([[index, index + query.length - 1]] as const);
}

function hasLiteralPaletteMatch(item: PaletteItem, query: string): boolean {
  return [item.title, item.description, item.meta, ...item.keywords].some(
    (value) => value?.toLocaleLowerCase().includes(query),
  );
}

export function searchPaletteItems(
  items: readonly PaletteItem[],
  rawQuery: string,
): PaletteSearchResult[] {
  const actionsOnly = rawQuery.startsWith('>');
  const query = (actionsOnly ? rawQuery.slice(1) : rawQuery)
    .trim()
    .toLocaleLowerCase();
  const candidates = actionsOnly
    ? items.filter((item) => item.group === 'Actions')
    : items;
  if (!query) {
    let visibleThreads = 0;
    return candidates.flatMap((item) => {
      if (item.group === 'Projects') return [];
      if (!actionsOnly && item.kind === 'action' && !item.contextual) return [];
      if (item.group === 'Threads') {
        visibleThreads += 1;
        if (visibleThreads > RECENT_PALETTE_THREADS) return [];
      }
      return [{ item, matches: {} }];
    });
  }

  if (query.length === 1) {
    return orderThreadResults(
      candidates.flatMap((item) => {
        const title = literalRanges(item.title, query);
        const description = literalRanges(item.description, query);
        const meta = literalRanges(item.meta, query);
        const keyword = item.keywords.some((value) =>
          value.toLocaleLowerCase().includes(query),
        );
        return title || description || meta || keyword
          ? [{ item, matches: { title, description, meta } }]
          : [];
      }),
    );
  }

  const fuse = new Fuse(candidates, {
    keys: [
      { name: 'title', weight: 0.55 },
      { name: 'keywords', weight: 0.2 },
      { name: 'description', weight: 0.15 },
      { name: 'meta', weight: 0.1 },
    ],
    includeMatches: true,
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 2,
    threshold: 0.32,
  });
  const fuzzyResults = fuse.search(query);
  const literalResults = fuzzyResults.filter((result) =>
    hasLiteralPaletteMatch(result.item, query),
  );
  return orderThreadResults(
    (literalResults.length ? literalResults : fuzzyResults).map((result) => ({
      item: result.item,
      matches: visibleMatches(result.matches),
    })),
  );
}
