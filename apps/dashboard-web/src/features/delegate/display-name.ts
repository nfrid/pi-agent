import { surfaceText } from './surface-state';

export interface DelegateDisplayIdentity {
  name?: string;
  workflow?: {
    logicalId?: string;
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
  const runName =
    logicalId && row.name === logicalId && !persistedName
      ? undefined
      : row.name;
  return surfaceText(
    persistedName ?? runName,
    logicalId ? humanizeDelegateLogicalId(logicalId) : 'Subagent',
  );
}
