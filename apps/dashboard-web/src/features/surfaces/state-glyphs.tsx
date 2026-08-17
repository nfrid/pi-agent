import type { ReactNode } from 'react';
import { PauseIcon } from '../pause-icon';

export function stateGlyph(state: string): ReactNode {
  if (state === 'paused') return <PauseIcon className="pause-icon" />;
  if (state === 'pausing')
    return <span className="pausing-icon" aria-hidden="true" />;
  if (state === 'running') return '●';
  if (state === 'done') return '✓';
  if (state === 'failed' || state === 'blocked') return '!';
  if (state === 'aborted') return '■';
  if (state === 'dropped') return '−';
  return '○';
}

export function short(value: string, max = 180): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}
