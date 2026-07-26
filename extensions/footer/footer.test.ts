import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { contextColor, formatTokenCount, joinParts } from './index';

// The footer's layout math is what these cover: it must never exceed the
// terminal width, since an over-wide footer line wraps and corrupts the frame.
const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

describe('formatTokenCount', () => {
  it('leaves small counts unscaled', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('scales thousands and drops a trailing zero', () => {
    expect(formatTokenCount(1_000)).toBe('1k');
    expect(formatTokenCount(1_500)).toBe('1.5k');
    expect(formatTokenCount(12_340)).toBe('12.3k');
  });

  it('scales millions', () => {
    expect(formatTokenCount(1_000_000)).toBe('1m');
    expect(formatTokenCount(2_450_000)).toBe('2.5m');
  });
});

describe('contextColor', () => {
  it('dims an unknown or low usage', () => {
    expect(contextColor(undefined)).toBe('dim');
    expect(contextColor(0)).toBe('dim');
    expect(contextColor(49)).toBe('dim');
  });

  it('warns from half full and errors from 80 percent', () => {
    expect(contextColor(50)).toBe('warning');
    expect(contextColor(79)).toBe('warning');
    expect(contextColor(80)).toBe('error');
    expect(contextColor(100)).toBe('error');
  });
});

describe('joinParts', () => {
  it('drops empty parts', () => {
    expect(joinParts(theme, 80, ['a', '', 'b'])).toBe('a • b');
  });

  it('returns an empty string when nothing is present', () => {
    expect(joinParts(theme, 80, ['', ''])).toBe('');
  });

  it('never exceeds the requested width', () => {
    const parts = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
    for (const width of [1, 5, 12, 30, 60]) {
      expect(visibleWidth(joinParts(theme, width, parts))).toBeLessThanOrEqual(
        width,
      );
    }
  });

  it('keeps the full text when it fits', () => {
    const line = joinParts(theme, 80, ['model', 'medium']);
    expect(line).toBe('model • medium');
  });

  it('truncates with an ellipsis when it does not fit', () => {
    const line = joinParts(theme, 10, ['averylongmodelname', 'medium']);
    expect(visibleWidth(line)).toBeLessThanOrEqual(10);
    // truncateToWidth appends a reset sequence after the ellipsis, so the
    // marker is not the final character of the raw string.
    expect(line).toContain('…');
    expect(line).toContain('averylong');
  });
});
