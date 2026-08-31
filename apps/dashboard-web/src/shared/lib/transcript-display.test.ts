import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeTranscriptPreviewPreference,
  setTranscriptPreviewPreference,
} from './transcript-display';

describe('transcript display preferences', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('normalizes missing, fractional, and out-of-range counts', () => {
    expect(normalizeTranscriptPreviewPreference(undefined)).toEqual({
      start: 1,
      end: 3,
    });
    expect(
      normalizeTranscriptPreviewPreference({ start: -3, end: 18.6 }),
    ).toEqual({ start: 0, end: 10 });
  });

  it('stores one normalized browser-local preference', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem });

    setTranscriptPreviewPreference({ start: 2.4, end: 99 });

    expect(setItem).toHaveBeenCalledWith(
      'pi-dashboard-transcript-preview-v1',
      JSON.stringify({ start: 2, end: 10 }),
    );
  });
});
