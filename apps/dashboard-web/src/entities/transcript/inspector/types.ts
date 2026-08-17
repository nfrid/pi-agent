import type { CustomToolKind } from '@pi-dashboard/activity-model';

export const INSPECTOR_MAX_TEXT = 1_200;
export const INSPECTOR_MAX_DEPTH = 3;
export const SPECIALIZED_PREVIEW_MAX_TEXT = 12_000;
export const INSPECTOR_MAX_KEYS = 16;
export const INSPECTOR_MAX_RAW_TEXT = 12_000;
export const SPECIALIZED_EDIT_MAX_REPLACEMENTS = 24;
export const RESULT_TEXT_MAX_DEPTH = 6;
export const RESULT_TEXT_MAX_BLOCKS = 128;
export const STRUCTURED_VIEW_MAX_DEPTH = 4;
export const STRUCTURED_VIEW_MAX_ENTRIES = 24;
export const STRUCTURED_VIEW_MAX_TEXT = 1_200;

export type BoundedValue = { text: string; truncated: boolean };
export type StructuredPrimitive = { text: string; truncated: boolean };
export type SpecializedToolKind =
  | 'write'
  | 'edit'
  | 'command'
  | 'read'
  | 'grep'
  | 'delete'
  | CustomToolKind;
export type ToolRecord = Record<string, unknown>;
export type NormalizedResultText = { text: string; truncated: boolean };
export type ResultTextWork = { value: unknown; depth: number };
