import {
  isActionAvailable,
  type RuntimeCapabilitySnapshot,
} from '@pi-dashboard/extension-contributions';
import type { BrowserSnapshot, RuntimeSnapshot } from '@pi-dashboard/protocol';
import Fuse, { type FuseResultMatch } from 'fuse.js';
import { sessionDisplayTitle } from '../../app-helpers';

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

// Keep the palette useful on large installations without creating a second
// unbounded session browser inside the dialog.
const MAX_PALETTE_PROJECTS = 24;
const MAX_PALETTE_SESSIONS = 24;
const RECENT_PALETTE_SESSIONS = 12;

function snapshotActions(snapshot: BrowserSnapshot) {
  return snapshot.runtimes.flatMap((runtime) =>
    runtime.online === false
      ? []
      : (runtime.capabilities?.manifests ?? []).flatMap((manifest) =>
          manifest.actions
            .filter((action) =>
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

export function paletteItems(snapshot: BrowserSnapshot): PaletteItem[] {
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
    }),
  );
  const sessions = snapshot.sessions.slice(0, MAX_PALETTE_SESSIONS).map(
    (session): PaletteItem => ({
      kind: 'navigate',
      id: `session:${session.id}`,
      group: 'Threads',
      title: sessionDisplayTitle(session),
      description: session.cwd,
      keywords: ['session', 'thread', session.id],
      icon: '●',
      path: `/sessions/${encodeURIComponent(session.id)}`,
    }),
  );
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
  return [...primary, ...actions, ...sessions, ...projects];
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
    let visibleSessions = 0;
    return candidates.flatMap((item) => {
      if (item.group === 'Projects') return [];
      if (item.group === 'Threads') {
        visibleSessions += 1;
        if (visibleSessions > RECENT_PALETTE_SESSIONS) return [];
      }
      return [{ item, matches: {} }];
    });
  }

  if (query.length === 1) {
    return candidates.flatMap((item) => {
      const title = literalRanges(item.title, query);
      const description = literalRanges(item.description, query);
      const meta = literalRanges(item.meta, query);
      const keyword = item.keywords.some((value) =>
        value.toLocaleLowerCase().includes(query),
      );
      return title || description || meta || keyword
        ? [{ item, matches: { title, description, meta } }]
        : [];
    });
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
  return (literalResults.length ? literalResults : fuzzyResults).map(
    (result) => ({
      item: result.item,
      matches: visibleMatches(result.matches),
    }),
  );
}
