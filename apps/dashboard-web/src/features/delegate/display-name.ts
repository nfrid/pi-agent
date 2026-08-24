import { surfaceText } from './surface-state';

export interface DelegateDisplayIdentity {
  name?: string;
  workflow?: {
    logicalId?: string;
    identity?: string;
    name?: string;
  };
}

export function humanizeDelegateLogicalId(reference: string): string {
  const logicalId = reference.replace(/@\d+$/, '');
  const words = logicalId.split(/[-_.]+/).filter(Boolean);
  return words.length
    ? words
        .map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
        .join(' ')
    : 'Delegate';
}

/** Prefer an explicit persisted title; make legacy logical IDs readable. */
export function delegateDisplayName(row: DelegateDisplayIdentity): string {
  const logicalId = row.workflow?.logicalId;
  const persistedName = row.workflow?.name;
  const canonicalAttempt = row.workflow?.identity;
  const canonicalFallbackName =
    !persistedName &&
    (row.name === logicalId ||
      row.name === canonicalAttempt ||
      /^[a-z][a-z0-9-]*@\d+$/u.test(row.name ?? ''));
  const fallbackIdentity = logicalId ?? row.name;
  return surfaceText(
    persistedName ?? (canonicalFallbackName ? undefined : row.name),
    fallbackIdentity ? humanizeDelegateLogicalId(fallbackIdentity) : 'Subagent',
  );
}
