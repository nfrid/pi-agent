import {
  type ArchiveThreadCommand,
  ArchiveThreadCommandSchema,
  type CancelCommand,
  CancelCommandSchema,
  type CheckoutActionCommand,
  CheckoutActionCommandSchema,
  type CheckoutReviewCommand,
  CheckoutReviewCommandSchema,
  type PinThreadCommand,
  PinThreadCommandSchema,
  type ProjectAdoptCommand,
  ProjectAdoptCommandSchema,
  type ProjectCreateCommand,
  ProjectCreateCommandSchema,
  type RegenerateThreadTitleCommand,
  RegenerateThreadTitleCommandSchema,
  type RestoreThreadCommand,
  RestoreThreadCommandSchema,
  type RetryCommand,
  RetryCommandSchema,
  type SessionAdoptCommand,
  SessionAdoptCommandSchema,
  type SettleThreadCommand,
  SettleThreadCommandSchema,
  type ThreadCreateCommand,
  ThreadCreateCommandSchema,
  type UnpinThreadCommand,
  UnpinThreadCommandSchema,
  type UnsettleThreadCommand,
  UnsettleThreadCommandSchema,
} from './orchestration-commands.js';
import {
  type Checkout,
  CheckoutSchema,
  type Project,
  ProjectSchema,
  type Run,
  RunSchema,
  type Thread,
  type ThreadLifecycleCommandResult,
  ThreadLifecycleCommandResultSchema,
  type ThreadLifecycleEvent,
  ThreadLifecycleEventSchema,
  ThreadSchema,
} from './orchestration-contracts.js';
import { parseSchema, tryParseSchema } from './utils.js';

export function parseProject(value: unknown): Project {
  return parseSchema(ProjectSchema, value, 'project');
}
export function tryParseProject(value: unknown): Project | undefined {
  return tryParseSchema(ProjectSchema, value);
}
export function parseCheckout(value: unknown): Checkout {
  return parseSchema(CheckoutSchema, value, 'checkout');
}
export function tryParseCheckout(value: unknown): Checkout | undefined {
  return tryParseSchema(CheckoutSchema, value);
}
export function parseThread(value: unknown): Thread {
  return parseSchema(ThreadSchema, value, 'thread');
}
export function tryParseThread(value: unknown): Thread | undefined {
  return tryParseSchema(ThreadSchema, value);
}
export function parseThreadLifecycleEvent(
  value: unknown,
): ThreadLifecycleEvent {
  return parseSchema(
    ThreadLifecycleEventSchema,
    value,
    'thread lifecycle event',
  );
}
export function tryParseThreadLifecycleEvent(
  value: unknown,
): ThreadLifecycleEvent | undefined {
  return tryParseSchema(ThreadLifecycleEventSchema, value);
}
export function parseThreadLifecycleCommandResult(
  value: unknown,
): ThreadLifecycleCommandResult {
  return parseSchema(
    ThreadLifecycleCommandResultSchema,
    value,
    'thread lifecycle command result',
  );
}
export function tryParseThreadLifecycleCommandResult(
  value: unknown,
): ThreadLifecycleCommandResult | undefined {
  return tryParseSchema(ThreadLifecycleCommandResultSchema, value);
}
export function parseRun(value: unknown): Run {
  return parseSchema(RunSchema, value, 'run');
}
export function tryParseRun(value: unknown): Run | undefined {
  return tryParseSchema(RunSchema, value);
}

export const parseProjectCreateCommand = (
  value: unknown,
): ProjectCreateCommand =>
  parseSchema(ProjectCreateCommandSchema, value, 'project create command');
export const tryParseProjectCreateCommand = (
  value: unknown,
): ProjectCreateCommand | undefined =>
  tryParseSchema(ProjectCreateCommandSchema, value);
export const parseProjectAdoptCommand = (value: unknown): ProjectAdoptCommand =>
  parseSchema(ProjectAdoptCommandSchema, value, 'project adopt command');
export const tryParseProjectAdoptCommand = (
  value: unknown,
): ProjectAdoptCommand | undefined =>
  tryParseSchema(ProjectAdoptCommandSchema, value);
export const parseSessionAdoptCommand = (value: unknown): SessionAdoptCommand =>
  parseSchema(SessionAdoptCommandSchema, value, 'session adopt command');
export const tryParseSessionAdoptCommand = (
  value: unknown,
): SessionAdoptCommand | undefined =>
  tryParseSchema(SessionAdoptCommandSchema, value);
export const parseThreadCreateCommand = (value: unknown): ThreadCreateCommand =>
  parseSchema(ThreadCreateCommandSchema, value, 'thread create command');
export const tryParseThreadCreateCommand = (
  value: unknown,
): ThreadCreateCommand | undefined =>
  tryParseSchema(ThreadCreateCommandSchema, value);
export const parseRetryCommand = (value: unknown): RetryCommand =>
  parseSchema(RetryCommandSchema, value, 'retry command');
export const tryParseRetryCommand = (
  value: unknown,
): RetryCommand | undefined => tryParseSchema(RetryCommandSchema, value);
export const parseCancelCommand = (value: unknown): CancelCommand =>
  parseSchema(CancelCommandSchema, value, 'cancel command');
export const tryParseCancelCommand = (
  value: unknown,
): CancelCommand | undefined => tryParseSchema(CancelCommandSchema, value);
export const parseCheckoutActionCommand = (
  value: unknown,
): CheckoutActionCommand =>
  parseSchema(CheckoutActionCommandSchema, value, 'checkout command');
export const tryParseCheckoutActionCommand = (
  value: unknown,
): CheckoutActionCommand | undefined =>
  tryParseSchema(CheckoutActionCommandSchema, value);
export const parseCheckoutReviewCommand = (
  value: unknown,
): CheckoutReviewCommand =>
  parseSchema(CheckoutReviewCommandSchema, value, 'checkout review command');
export const tryParseCheckoutReviewCommand = (
  value: unknown,
): CheckoutReviewCommand | undefined =>
  tryParseSchema(CheckoutReviewCommandSchema, value);
export const parseArchiveThreadCommand = (
  value: unknown,
): ArchiveThreadCommand =>
  parseSchema(ArchiveThreadCommandSchema, value, 'thread archive command');
export const tryParseArchiveThreadCommand = (
  value: unknown,
): ArchiveThreadCommand | undefined =>
  tryParseSchema(ArchiveThreadCommandSchema, value);
export const parseRestoreThreadCommand = (
  value: unknown,
): RestoreThreadCommand =>
  parseSchema(RestoreThreadCommandSchema, value, 'thread restore command');
export const tryParseRestoreThreadCommand = (
  value: unknown,
): RestoreThreadCommand | undefined =>
  tryParseSchema(RestoreThreadCommandSchema, value);
export const parseRegenerateThreadTitleCommand = (
  value: unknown,
): RegenerateThreadTitleCommand =>
  parseSchema(
    RegenerateThreadTitleCommandSchema,
    value,
    'thread title regeneration command',
  );
export const tryParseRegenerateThreadTitleCommand = (
  value: unknown,
): RegenerateThreadTitleCommand | undefined =>
  tryParseSchema(RegenerateThreadTitleCommandSchema, value);
export const parsePinThreadCommand = (value: unknown): PinThreadCommand =>
  parseSchema(PinThreadCommandSchema, value, 'thread pin command');
export const tryParsePinThreadCommand = (
  value: unknown,
): PinThreadCommand | undefined =>
  tryParseSchema(PinThreadCommandSchema, value);
export const parseUnpinThreadCommand = (value: unknown): UnpinThreadCommand =>
  parseSchema(UnpinThreadCommandSchema, value, 'thread unpin command');
export const parseSettleThreadCommand = (value: unknown): SettleThreadCommand =>
  parseSchema(SettleThreadCommandSchema, value, 'thread settle command');
export const tryParseSettleThreadCommand = (
  value: unknown,
): SettleThreadCommand | undefined =>
  tryParseSchema(SettleThreadCommandSchema, value);
export const parseUnsettleThreadCommand = (
  value: unknown,
): UnsettleThreadCommand =>
  parseSchema(UnsettleThreadCommandSchema, value, 'thread unsettle command');
export const tryParseUnsettleThreadCommand = (
  value: unknown,
): UnsettleThreadCommand | undefined =>
  tryParseSchema(UnsettleThreadCommandSchema, value);
export const tryParseUnpinThreadCommand = (
  value: unknown,
): UnpinThreadCommand | undefined =>
  tryParseSchema(UnpinThreadCommandSchema, value);
