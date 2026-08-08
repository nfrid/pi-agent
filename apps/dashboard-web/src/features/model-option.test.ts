import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { describe, expect, it } from 'vitest';
import {
  configuredModelOptions,
  modelOptionValue,
  parseModelOptionValue,
} from './model-option';

describe('model option values', () => {
  it('round-trips providers and models that contain slashes', () => {
    const value = modelOptionValue('gateway/openai', 'family/model');
    expect(value).toBe('gateway%2Fopenai/family%2Fmodel');
    expect(parseModelOptionValue(value)).toEqual({
      provider: 'gateway/openai',
      model: 'family/model',
    });
  });

  it('rejects malformed encoded selections', () => {
    expect(parseModelOptionValue('missing-separator')).toBeUndefined();
    expect(parseModelOptionValue('%invalid/value')).toBeUndefined();
  });

  it('prefers a configured catalogue over a capped full registry', () => {
    const configured = Array.from({ length: 7 }, (_, index) => ({
      provider: 'openai-codex',
      model: index === 0 ? 'current' : `configured-${index}`,
    }));
    const full = [
      { provider: 'openai-codex', model: 'current' },
      ...Array.from({ length: 255 }, (_, index) => ({
        provider: 'available',
        model: `model-${index}`,
      })),
    ];
    const preferred = {
      cwd: '/project',
      model: { provider: 'openai-codex', model: 'current' },
      modelCatalog: full,
    } as RuntimeSnapshot;
    expect(
      configuredModelOptions(
        [
          preferred,
          { cwd: '/project', modelCatalog: configured } as RuntimeSnapshot,
        ],
        preferred,
      ),
    ).toEqual(configured);
  });

  it('does not borrow an active catalogue from another workspace', () => {
    const preferred = {
      cwd: '/one',
      model: { provider: 'openai-codex', model: 'current' },
      modelCatalog: [
        { provider: 'openai-codex', model: 'current' },
        { provider: 'openai-codex', model: 'other' },
        ...Array.from({ length: 254 }, (_, index) => ({
          provider: 'available',
          model: `model-${index}`,
        })),
      ],
    } as RuntimeSnapshot;
    const foreign = {
      cwd: '/two',
      modelCatalog: [
        { provider: 'openai-codex', model: 'current' },
        { provider: 'openai-codex', model: 'other' },
      ],
    } as RuntimeSnapshot;
    expect(configuredModelOptions([preferred, foreign], preferred)).toEqual([
      { provider: 'openai-codex', model: 'current' },
    ]);
  });

  it('fails closed when new chat only sees a capped full registry', () => {
    const full = Array.from({ length: 256 }, (_, index) => ({
      provider: 'available',
      model: `model-${index}`,
    }));
    expect(
      configuredModelOptions([{ modelCatalog: full } as RuntimeSnapshot]),
    ).toEqual([]);
  });

  it('unions configured catalogues while excluding capped registries', () => {
    const full = Array.from({ length: 256 }, (_, index) => ({
      provider: 'available',
      model: `model-${index}`,
    }));
    expect(
      configuredModelOptions([
        { modelCatalog: full } as RuntimeSnapshot,
        {
          modelCatalog: [
            { provider: 'openai-codex', model: 'one' },
            { provider: 'openai-codex', model: 'two' },
          ],
        } as RuntimeSnapshot,
      ]),
    ).toEqual([
      { provider: 'openai-codex', model: 'one' },
      { provider: 'openai-codex', model: 'two' },
    ]);
  });
});
