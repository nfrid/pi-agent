import { Type } from 'typebox';
import { afterEach, describe, expect, test } from 'vitest';
import {
  aggregateRuntimeCapabilities,
  listRegisteredCapabilityIds,
  registerExtensionCapability,
  unregisterExtensionCapability,
} from './capability-registry';
import { releaseScopedServices } from './scoped-services';

afterEach(() => {
  for (const id of listRegisteredCapabilityIds())
    unregisterExtensionCapability(id);
  releaseScopedServices('default');
});

describe('capability registry', () => {
  test('aggregates manifests and capabilities from registered extensions', () => {
    registerExtensionCapability({
      id: 'sample',
      manifest: {
        id: 'sample',
        version: '1',
        actions: [
          {
            id: 'sample.ping',
            inputSchema: Type.Object({}, { additionalProperties: false }),
            idempotent: true,
          },
        ],
        renderers: [],
      },
      capabilities: [
        {
          id: 'sample.capability',
          version: '1',
          available: true,
        },
      ],
      actionHandlers: {
        'sample.ping': () => ({ ok: true }),
      },
    });
    const snapshot = aggregateRuntimeCapabilities('default');
    expect(snapshot.manifests.map((manifest) => manifest.id)).toContain(
      'sample',
    );
    expect(snapshot.capabilities.map((capability) => capability.id)).toContain(
      'sample.capability',
    );
  });
});
