import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';

export const DELEGATE_RUNTIME_WARNING_MESSAGE_TYPE = 'delegate-runtime-warning';
export const DELEGATE_RUNTIME_WARNING_ENTRY_TYPE =
  'delegate-runtime-warning:v1';

export interface DelegateRuntimeWarningTarget {
  readonly identity: string;
  readonly logicalId: string;
  readonly route: string;
}

export interface DelegateRuntimeWarningDetails {
  readonly identity: string;
  readonly logicalId: string;
  readonly route: string;
  readonly startedAt: number;
  readonly elapsedMs: number;
  readonly warningAfterMs: number;
  readonly status: 'warning';
}

export type DelegateRuntimeWarningState = 'pending' | 'delivered' | 'settled';

export interface DelegateRuntimeWarningRecord {
  readonly version: 1;
  readonly ownerBranchId: string;
  readonly state: DelegateRuntimeWarningState;
  readonly warning: DelegateRuntimeWarningDetails;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

export function isDelegateRuntimeWarningRecord(
  value: unknown,
): value is DelegateRuntimeWarningRecord {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !validText(value.ownerBranchId)
  )
    return false;
  if (
    value.state !== 'pending' &&
    value.state !== 'delivered' &&
    value.state !== 'settled'
  )
    return false;
  const warning = value.warning;
  return (
    isRecord(warning) &&
    validText(warning.identity) &&
    validText(warning.logicalId) &&
    validText(warning.route) &&
    typeof warning.startedAt === 'number' &&
    Number.isSafeInteger(warning.startedAt) &&
    warning.startedAt >= 0 &&
    typeof warning.elapsedMs === 'number' &&
    Number.isSafeInteger(warning.elapsedMs) &&
    warning.elapsedMs >= 0 &&
    typeof warning.warningAfterMs === 'number' &&
    Number.isSafeInteger(warning.warningAfterMs) &&
    warning.warningAfterMs > 0 &&
    warning.status === 'warning'
  );
}

/** Fold only records owned by this exact parent branch. */
export function foldDelegateRuntimeWarnings(
  entries: readonly unknown[],
  ownerBranchId: string,
): Map<string, DelegateRuntimeWarningRecord> {
  const records = new Map<string, DelegateRuntimeWarningRecord>();
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      entry.type !== 'custom' ||
      entry.customType !== DELEGATE_RUNTIME_WARNING_ENTRY_TYPE ||
      !isDelegateRuntimeWarningRecord(entry.data) ||
      entry.data.ownerBranchId !== ownerBranchId
    )
      continue;
    records.set(entry.data.warning.identity, entry.data);
  }
  return records;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours} hour${hours === 1 ? '' : 's'}${remainingMinutes ? ` ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}` : ''}`;
}

export function formatDelegateRuntimeWarning(
  warning: DelegateRuntimeWarningDetails,
): string {
  return [
    'Delegate runtime check',
    `Delegate ${warning.identity} (${warning.route}) has been running for ${formatDuration(warning.elapsedMs)} and is still active. The runtime review threshold is ${formatDuration(warning.warningAfterMs)}; no automatic stop was applied. Inspect recent activity once if it would help decide whether to leave it running, send feedback, or cancel. A lack of visible activity alone does not establish a stall.`,
  ].join('\n\n');
}

export function registerDelegateRuntimeWarningRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(
    DELEGATE_RUNTIME_WARNING_MESSAGE_TYPE,
    (message, { expanded, outputPad }, theme) => {
      const content =
        typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .filter(
                  (part): part is { type: 'text'; text: string } =>
                    part.type === 'text' && typeof part.text === 'string',
                )
                .map((part) => part.text)
                .join('\n')
            : '';
      const details = message.details as
        | DelegateRuntimeWarningDetails
        | undefined;
      const title = details?.identity
        ? `⚠ Delegate runtime check · ${details.identity} · ${details.route} · ${formatDuration(details.elapsedMs)}`
        : '⚠ Delegate runtime check';
      const visible = expanded
        ? `${title}\n${content.replace(/^Delegate runtime check\n*/u, '')}`
        : truncateToWidth(title, 120, '…');
      return new Text(theme.fg('warning', visible), outputPad, 0);
    },
  );
}
