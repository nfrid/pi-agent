import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ExtensionAPI,
  ModelRuntime,
  type ProviderConfig,
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';
import { clearAllNativeSteeringControllers } from '../shared/runtime/native-steering';
import nativeSteeringExtension from './index';

afterEach(() => {
  clearAllNativeSteeringControllers('registration test cleanup');
  vi.unstubAllGlobals();
});

it('registers the real default extension with an SDK-valid provider API without network requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-steering-registration-'));
  const network = vi.fn<typeof globalThis.fetch>(async () => {
    throw new Error('Network disabled in the startup registration canary.');
  });
  vi.stubGlobal('fetch', network);
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(root, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(root, 'models.sqlite'),
      refreshOnCreate: false,
    });
    let registration:
      | { providerId: string; config: ProviderConfig }
      | undefined;
    const api = {
      on: vi.fn(),
      registerProvider(providerId: string, config: ProviderConfig) {
        registration = { providerId, config };
      },
    } as unknown as ExtensionAPI;
    nativeSteeringExtension(api);
    expect(registration?.providerId).toBe('openai');
    expect(registration?.config.api).toBe('openai-responses');
    if (!registration)
      throw new Error('Expected native provider registration.');
    const { providerId, config } = registration;
    expect(() => runtime.registerProvider(providerId, config)).not.toThrow();
    expect(network).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
