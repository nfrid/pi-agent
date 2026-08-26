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
  const isCanonicalIdentity = (value: string | undefined) =>
    value === logicalId ||
    value === canonicalAttempt ||
    /^[a-z][a-z0-9-]*@\d+$/u.test(value ?? '');
  const explicitName =
    persistedName && !isCanonicalIdentity(persistedName)
      ? persistedName
      : row.name && !isCanonicalIdentity(row.name)
        ? row.name
        : undefined;
  const fallbackIdentity = logicalId ?? row.name;
  return surfaceText(
    explicitName,
    fallbackIdentity ? humanizeDelegateLogicalId(fallbackIdentity) : 'Subagent',
  );
}
