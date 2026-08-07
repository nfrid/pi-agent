import { describe, expect, it } from 'vitest';
import { modelOptionValue, parseModelOptionValue } from './model-option';

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
});
