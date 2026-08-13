import { describe, expect, it } from 'vitest';
import { compatibilityHash, deriveCompatibilityLineageId } from './identity';

describe('delegate compatibility identity', () => {
  it('keeps the browser-safe lineage compatibility vector stable', () => {
    expect(compatibilityHash('delegate-lineage:legacy-token')).toBe(
      'dea8c20f3c21ef45',
    );
    expect(deriveCompatibilityLineageId('legacy-token')).toBe(
      'dl-dea8c20f3c21ef45',
    );
  });
});
