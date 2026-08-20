import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
  ContributionError,
  createRuntimeCapabilitySnapshot,
  type ExtensionManifest,
  findActionDescriptor,
  findRendererDescriptor,
  isActionAvailable,
  NonIdempotentActionIdGuard,
  parseActionInput,
  parseExtensionManifest,
  parseExtensionSurface,
  parseExtensionSurfaceList,
  parseRuntimeCapabilitySnapshot,
  safeRuntimeCapabilitySnapshot,
  selectAvailableActions,
  tryParseExtensionSurface,
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

  it('rejects contribution IDs duplicated across manifests in every category', () => {
    const inspector = {
      id: 'demo.inspector',
      inputSchema: Type.Object({}, { additionalProperties: false }),
    };
    const cases: readonly [
      string,
      Partial<Pick<ExtensionManifest, 'actions' | 'renderers' | 'inspectors'>>,
    ][] = [
      ['action', { actions: [action] }],
      ['renderer', { renderers: manifest.renderers }],
      ['inspector', { inspectors: [inspector] }],
    ];
    for (const [label, contribution] of cases) {
      const duplicate: ExtensionManifest = {
        id: `other-${label}`,
        version: '1',
        actions: contribution.actions ?? [],
        renderers: contribution.renderers ?? [],
        ...(contribution.inspectors
          ? { inspectors: contribution.inspectors }
          : {}),
      };
      const source: ExtensionManifest = {
        ...manifest,
        ...(contribution.inspectors
          ? { inspectors: contribution.inspectors }
          : {}),
      };
      expect(() =>
        createRuntimeCapabilitySnapshot([source, duplicate]),
      ).toThrow(`Duplicate ${label} across manifests ID`);
    }
  });

  it('rejects duplicates before order-dependent descriptor lookup', () => {
    const duplicate: ExtensionManifest = {
      ...manifest,
      id: 'other-demo',
    };
    expect(() =>
      findActionDescriptor([manifest, duplicate], action.id),
    ).toThrow('across manifests');
    expect(() =>
      findRendererDescriptor([manifest, duplicate], 'demo.view'),
    ).toThrow('across manifests');
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

  it('parses typed live surfaces and maps invalid values to a safe failure', () => {
    const surface = parseExtensionSurface({
      id: 'tasks.current',
      rendererId: 'tasks.current',
      placement: 'left-rail',
      viewModel: { version: 1, tasks: [] },
    });
    expect(surface.placement).toBe('left-rail');
    expect(parseExtensionSurfaceList([surface])).toEqual([surface]);
    expect(() => parseExtensionSurfaceList([surface, surface])).toThrow(
      'Duplicate extension surface ID',
    );
    expect(tryParseExtensionSurface({ ...surface, placement: 'unknown' })).toBe(
      undefined,
    );
    expect(() => parseExtensionSurface({ ...surface, extra: true })).toThrow(
      'invalid or unknown',
    );
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
