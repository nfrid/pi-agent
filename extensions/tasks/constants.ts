import type { Action, Status } from './types';

export const EXT = 'lean-todo';
export const TOOL = 'todo';
export const MAX_REPLAY_CHARS = 12_000;
export const MAX_WIDGET_LINES = 12;
export const MAX_RENDER_ITEMS = 14;

export const STATUS_GLYPH: Record<Status, string> = {
  todo: '○',
  doing: '◐',
  blocked: '!',
  done: '✓',
  dropped: '⊘',
};

export const ACTION_GLYPH: Record<Action, string> = {
  list: '☰',
  add: '+',
  update: '→',
  start: '◐',
  done: '✓',
  block: '!',
  drop: '⊘',
  remove: '×',
  clear_done: '∅',
  replace: '⇄',
  batch: '⋯',
};
