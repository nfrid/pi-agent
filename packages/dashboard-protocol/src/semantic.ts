import type { WorkspaceTarget } from './schemas.js';
import { isRecord } from './utils.js';

export { SESSION_NAME_MAX_LENGTH } from './limits.js';

const WORKSPACE_SOURCE_PRIORITY: Record<WorkspaceTarget['source'], number> = {
  tmux: 3,
  'sesh-config': 2,
  directory: 1,
  zoxide: 0,
};

export function workspaceSourcePriority(
  source: WorkspaceTarget['source'],
): number {
  return WORKSPACE_SOURCE_PRIORITY[source];
}

/** Choose the closest containing workspace, preferring explicit sources on ties. */
export function workspaceForPath(
  value: string,
  workspaces: readonly WorkspaceTarget[],
): WorkspaceTarget | undefined {
  let best: WorkspaceTarget | undefined;
  for (const workspace of workspaces) {
    const root = workspace.canonicalPath.replace(/\/$/u, '') || '/';
    const contains =
      value === root || value.startsWith(root === '/' ? root : `${root}/`);
    if (!contains) continue;
    const bestRoot = best
      ? best.canonicalPath.replace(/\/$/u, '') || '/'
      : undefined;
    if (
      !best ||
      (bestRoot !== undefined && root.length > bestRoot.length) ||
      (bestRoot !== undefined &&
        root.length === bestRoot.length &&
        workspaceSourcePriority(workspace.source) >
          workspaceSourcePriority(best.source))
    )
      best = workspace;
  }
  return best;
}

export const SESSION_TITLE_MAX_LENGTH = 96;

/** Normalize a user message into a compact, stable dashboard title. */
export function normalizeSessionTitle(value: string): string | undefined {
  const normalized = [...value.normalize('NFKC')]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return undefined;
  const characters = [...normalized];
  return characters.length <= SESSION_TITLE_MAX_LENGTH
    ? normalized
    : `${characters.slice(0, SESSION_TITLE_MAX_LENGTH - 1).join('')}…`;
}

function textFromMessageContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!isRecord(part) || typeof part.text !== 'string') return '';
      return part.text;
    })
    .filter(Boolean)
    .join(' ');
  return text || undefined;
}

/** Return the first non-empty user message title in Pi session entries. */
export function deriveSessionTitle(
  entries: readonly unknown[],
): string | undefined {
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== 'message') continue;
    const message = isRecord(entry.message) ? entry.message : entry;
    if (message.role !== 'user') continue;
    const text = textFromMessageContent(message.content);
    const title = text ? normalizeSessionTitle(text) : undefined;
    if (title) return title;
  }
  return undefined;
}
