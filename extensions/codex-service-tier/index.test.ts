import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import codexServiceTierExtension from './index';

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function fixture(flag?: string, priorTier?: string) {
  const handlers = new Map<string, Handler>();
  const entries: Array<{ customType: string; data: unknown }> = priorTier
    ? [{ customType: 'codex-service-tier', data: { tier: priorTier } }]
    : [];
  const pi = {
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => flag),
    registerCommand: vi.fn(),
    on: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)),
    appendEntry: vi.fn((customType: string, data: unknown) =>
      entries.push({ customType, data }),
    ),
    events: { emit: vi.fn() },
  } as unknown as ExtensionAPI;
  codexServiceTierExtension(pi);
  const manager = {
    getBranch: () => entries.map((entry) => ({ type: 'custom', ...entry })),
  };
  const ctx = {
    model: { provider: 'openai-codex' },
    sessionManager: manager,
    ui: { notify: vi.fn(), select: vi.fn() },
  } as unknown as ExtensionContext;
  return { handlers, pi, ctx };
}

async function payloadFor(flag: string, payload: unknown = { model: 'gpt' }) {
  const { handlers, ctx } = fixture(flag);
  await handlers.get('session_start')?.({}, ctx);
  return handlers.get('before_provider_request')?.({ payload }, ctx);
}

describe('codex service tier', () => {
  it.each([
    ['normal', { model: 'gpt' }],
    ['fast', { model: 'gpt', service_tier: 'priority' }],
    ['ultrafast', { model: 'gpt', service_tier: 'ultrafast' }],
  ])('maps %s to the Codex request payload', async (flag, expected) => {
    await expect(payloadFor(flag)).resolves.toEqual(expected);
  });

  it('uses explicit normal to clear a restored fast tier', async () => {
    const { handlers, ctx } = fixture('normal', 'fast');
    await handlers.get('session_start')?.({}, ctx);
    expect(
      handlers.get('before_provider_request')?.(
        { payload: { model: 'gpt', service_tier: 'priority' } },
        ctx,
      ),
    ).toEqual({ model: 'gpt' });
  });

  it('restores the session tier when no launch flag is present', async () => {
    const { handlers, ctx } = fixture(undefined, 'fast');
    await handlers.get('session_start')?.({}, ctx);
    expect(
      handlers.get('before_provider_request')?.(
        { payload: { model: 'gpt' } },
        ctx,
      ),
    ).toEqual({ model: 'gpt', service_tier: 'priority' });
  });

  it('clears the tier when the session switches away from Codex', async () => {
    const { handlers, ctx } = fixture('fast');
    await handlers.get('session_start')?.({}, ctx);
    handlers.get('model_select')?.({ model: { provider: 'anthropic' } }, ctx);
    expect(
      handlers.get('before_provider_request')?.(
        { payload: { model: 'gpt' } },
        ctx,
      ),
    ).toEqual({ model: 'gpt' });
  });

  it('does not change non-Codex or malformed payloads', async () => {
    const { handlers, ctx } = fixture('fast');
    await handlers.get('session_start')?.({}, ctx);
    expect(
      handlers.get('before_provider_request')?.(
        { payload: { model: 'claude' } },
        { ...ctx, model: { provider: 'anthropic' } } as never,
      ),
    ).toBeUndefined();
    expect(
      handlers.get('before_provider_request')?.({ payload: null }, ctx),
    ).toBeUndefined();
  });
});
