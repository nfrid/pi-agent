import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
  ContributionError,
  createRuntimeCapabilitySnapshot,
  type ExtensionManifest,
  isActionAvailable,
  NonIdempotentActionIdGuard,
  parseActionInput,
  parseExtensionManifest,
  parseRuntimeCapabilitySnapshot,
  safeRuntimeCapabilitySnapshot,
  selectAvailableActions,
} from './index.js';

const action = {
  id: 'demo.run',
  inputSchema: Type.Object(
    { value: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  availability: { requires: ['demo'] },
};
const manifest: ExtensionManifest = {
  id: 'demo',
  version: '1',
  actions: [action],
  renderers: [
    {
      id: 'demo.view',
      mode: 'generic',
      inputSchema: Type.Object({}, { additionalProperties: false }),
    },
  ],
};

const capabilities = createRuntimeCapabilitySnapshot(
  [manifest],
  [{ id: 'demo', version: '1', available: true }],
);

describe('extension contribution contracts', () => {
  it('rejects unknown manifest fields and duplicate IDs', () => {
    expect(() =>
      parseExtensionManifest({ ...manifest, unknown: true }),
    ).toThrow(ContributionError);
    expect(() =>
      parseExtensionManifest({
        ...manifest,
        actions: [action, { ...action, inputSchema: action.inputSchema }],
      }),
    ).toThrow('Duplicate action ID');
  });

  it('validates action input and pure availability', () => {
    expect(parseActionInput(action, { value: 'ok' })).toEqual({ value: 'ok' });
    expect(() => parseActionInput(action, { value: '' })).toThrow(
      'Invalid input',
    );
    expect(isActionAvailable(action, capabilities, { online: true })).toBe(
      true,
    );
    expect(
      isActionAvailable(action, safeRuntimeCapabilitySnapshot(undefined), {
        online: true,
      }),
    ).toBe(false);
    expect(selectAvailableActions([manifest], capabilities)).toHaveLength(1);
  });

  it('fails closed at action-ID capacity without evicting duplicates', () => {
    const guard = new NonIdempotentActionIdGuard(2);
    expect(guard.reserve('one')).toBe('reserved');
    expect(guard.reserve('two')).toBe('reserved');
    expect(guard.reserve('one')).toBe('duplicate');
    expect(guard.reserve('three')).toBe('capacity');
    expect(guard.has('one')).toBe(true);
    expect(guard.size).toBe(2);
  });

  it('rejects malformed capability snapshots and safely empties unknown data', () => {
    expect(() =>
      parseRuntimeCapabilitySnapshot({
        ...capabilities,
        extra: true,
      }),
    ).toThrow('invalid or unknown');
    expect(
      safeRuntimeCapabilitySnapshot({ version: 1, manifests: [] }),
    ).toEqual({
      version: 1,
      capabilities: [],
      manifests: [],
    });
  });
});
